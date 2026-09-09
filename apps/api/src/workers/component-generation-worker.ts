import '../load-env.js';
import { Queue, Worker, type Job } from 'bullmq';
import type { CodeTarget, ComponentEvidence, ComponentGenerationJob, ComponentGenerationStatus, GenerationErrorCategory } from '@origami/contracts';
import { ComponentGenerator } from '../component-generator.js';
import { UnifiedComponentStore } from '../unified-component-store.js';
import { getRedisConnection } from './website-scan-worker.js';

const QUEUE_NAME = 'component-generation-jobs';

/**
 * Structured, non-sensitive lifecycle log — jobId/target/duration/reason
 * only. Never the screenshot, DOM/HTML content, or anything from the user's
 * page. Grep-able event names match the ones this project's other AI
 * diagnostics already use (see gateway.ts's logAiUnavailable).
 */
function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * A misconfigured timeout (zero, negative, NaN, or absurdly small) is worse
 * than no override at all — it would fire before a single AI Gateway round
 * trip could ever complete, silently breaking every generation. Falls back
 * to the safe default and logs why, rather than either crashing the process
 * or quietly running with a nonsensical value.
 */
function validatedTimeoutMs(envValue: string | undefined, defaultMs: number, minMs: number, label: string): number {
  if (envValue === undefined || envValue === '') return defaultMs;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < minMs) {
    console.error(JSON.stringify({ event: 'invalid_timeout_config', label, providedValue: envValue, minMs, fallbackMs: defaultMs }));
    return defaultMs;
  }
  return parsed;
}

/**
 * Set to true only once startComponentGenerationWorker() has actually
 * constructed a live BullMQ Worker bound to Redis. Exposed via
 * isComponentWorkerRunning() so /health/dependencies can report an honest
 * readiness signal instead of a job silently sitting QUEUED forever with no
 * observable reason — exactly the original Redis-down failure mode, just
 * one layer up (Redis reachable, but nothing actually consuming the queue).
 */
let workerStarted = false;
export function isComponentWorkerRunning(): boolean {
  return workerStarted;
}

/**
 * Overall wall-clock ceiling for one generation job (both AI Gateway stages
 * combined), independent of and in addition to gateway.ts's own per-call
 * timeout. This is what actually bounds a stuck job — a report of a
 * generation running for 22+ minutes with no way to stop it is exactly the
 * failure mode this closes: previously there was no job-level ceiling at
 * all, only per-HTTP-call timeouts, so a job stuck in an unexpected way
 * (e.g. queued behind another hung job, or a network condition an
 * AbortSignal.timeout doesn't cleanly cover) had nothing to end it.
 * 10 minutes comfortably covers two sequential cold-loaded model calls
 * (observed worst case in this environment: ~170s combined once warm) while
 * still being far short of "runs forever."
 */
const DEFAULT_COMPONENT_GENERATION_TIMEOUT_MS = 600_000;
/** Only zero/negative/non-finite is rejected as unsafe — a deliberately small positive value (e.g. in tests) is a legitimate, if unusual, configuration, not an error. */
const MIN_COMPONENT_GENERATION_TIMEOUT_MS = 1;
const COMPONENT_GENERATION_TIMEOUT_MS = validatedTimeoutMs(
  process.env.COMPONENT_GENERATION_TIMEOUT_MS,
  DEFAULT_COMPONENT_GENERATION_TIMEOUT_MS,
  MIN_COMPONENT_GENERATION_TIMEOUT_MS,
  'COMPONENT_GENERATION_TIMEOUT_MS',
);

const TERMINAL_STATUSES: ComponentGenerationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED_PRIVACY', 'TIMED_OUT'];
function isTerminal(status: ComponentGenerationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface ComponentJobPayload {
  jobId: string;
  sourceUrl: string;
  pageTitle?: string;
  target: CodeTarget;
  evidence: ComponentEvidence;
  ownerId?: string;
}

interface JobControl {
  controller: AbortController;
  /** Set the instant a stop is requested — authoritative over whatever the
   *  in-flight generate() call happens to return, so a late-arriving success
   *  can never overwrite a cancellation the caller already asked for. */
  cancelReason: 'user' | 'timeout' | null;
}

/**
 * Live AbortControllers for jobs currently being processed, keyed by jobId.
 * Necessarily in-memory only — an AbortController can't be persisted or
 * survive an API process restart, same as any other live JS handle. A job
 * cancelled while its owning process is down simply has no in-flight request
 * to abort; see the report's "limitations" section.
 */
const jobControls = new Map<string, JobControl>();

let queue: Queue<ComponentJobPayload> | null = null;

function getQueue(): Queue<ComponentJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue<ComponentJobPayload>(QUEUE_NAME, { connection });
  }
  return queue;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Runs one generation job to completion and persists the result. Always runs
 * in the same Node process as the API (not a separate process, matching how
 * the website-scan worker runs by default) — this is what makes the job
 * independent of the popup/extension: the API process owns it, not any
 * browser-side code, regardless of whether Redis is configured.
 */
async function processJob(
  store: UnifiedComponentStore,
  generator: ComponentGenerator,
  payload: ComponentJobPayload,
): Promise<void> {
  const repo = store.getRepository();

  // Guard against the race where /cancel already marked this job CANCELLED
  // while it was still QUEUED (not yet picked up by a worker, or its BullMQ
  // removal didn't win the race) — never resurrect a cancelled job by
  // overwriting it with RUNNING. No `await` happens between this check and
  // registering the AbortController below, so nothing can interleave here.
  const existing = await store.getJobAsync(payload.jobId);
  if (existing && isTerminal(existing.status)) {
    return;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const control: JobControl = { controller, cancelReason: null };
  jobControls.set(payload.jobId, control);

  const timeoutTimer = setTimeout(() => {
    control.cancelReason = 'timeout';
    controller.abort();
  }, COMPONENT_GENERATION_TIMEOUT_MS);

  await repo.updateStatus(payload.jobId, 'RUNNING').catch(() => {});

  const running: ComponentGenerationJob = {
    jobId: payload.jobId,
    ownerId: payload.ownerId,
    sourceUrl: payload.sourceUrl,
    pageTitle: payload.pageTitle,
    target: payload.target,
    status: 'RUNNING',
    aiAvailable: false,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  store.saveJob(running);
  logLifecycle('generation_started', { jobId: payload.jobId, target: payload.target });

  const finalize = async (outcome: {
    status: ComponentGenerationStatus;
    componentName?: string;
    result?: ComponentGenerationJob['result'];
    verification?: ComponentGenerationJob['verification'];
    aiAvailable: boolean;
    error?: string;
    errorCategory?: GenerationErrorCategory;
  }) => {
    // Server-side job state is authoritative: a stop/timeout request recorded
    // on this job's control entry always wins over whatever generate() itself
    // returned, including a "successful" result that happened to finish
    // composing itself right as cancellation was requested.
    let status = outcome.status;
    let error = outcome.error;
    let errorCategory = outcome.errorCategory;
    if (control.cancelReason === 'user') {
      status = 'CANCELLED';
      error = 'Generation cancelled by user.';
      errorCategory = 'USER_CANCELLED';
    } else if (control.cancelReason === 'timeout') {
      status = 'TIMED_OUT';
      error = `Generation timed out after ${Math.round(COMPONENT_GENERATION_TIMEOUT_MS / 60000)} minute(s). Please try again.`;
      errorCategory = 'MODEL_TIMEOUT';
    }

    const durationMs = Date.now() - startedAt;
    const finished: ComponentGenerationJob = {
      ...running,
      status,
      error,
      errorCategory,
      result: control.cancelReason ? undefined : outcome.result,
      verification: control.cancelReason ? undefined : outcome.verification,
      aiAvailable: outcome.aiAvailable,
      updatedAt: nowIso(),
    };
    store.saveJob(finished);
    await repo.completeJob(payload.jobId, {
      status,
      componentName: control.cancelReason ? undefined : outcome.componentName,
      result: finished.result,
      verification: finished.verification,
      aiAvailable: outcome.aiAvailable,
      error,
      errorCategory,
    }).catch(() => {});

    if (control.cancelReason) {
      // The abort was requested earlier (see cancelComponentJob / the
      // timeoutTimer above) — this is confirmation the downstream chain
      // (component-generator -> AI Router -> Ollama) actually settled in
      // response to it, not just that we stopped waiting.
      logLifecycle('generation_abort_completed', { jobId: payload.jobId, reason: control.cancelReason, durationMs });
    }
    const eventByStatus: Partial<Record<ComponentGenerationStatus, string>> = {
      COMPLETED: 'generation_completed',
      FAILED: 'generation_failed',
      CANCELLED: 'generation_cancelled',
      TIMED_OUT: 'generation_timeout',
      BLOCKED_PRIVACY: 'generation_failed',
    };
    logLifecycle(eventByStatus[status] ?? 'generation_failed', { jobId: payload.jobId, target: payload.target, status, durationMs, errorCategory });
  };

  try {
    const outcome = await generator.generate(payload.sourceUrl, payload.target, payload.evidence, controller.signal);
    await finalize(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Component generation failed';
    await finalize({ status: 'FAILED', aiAvailable: false, error: message, errorCategory: 'WORKER_ERROR' });
  } finally {
    clearTimeout(timeoutTimer);
    jobControls.delete(payload.jobId);
  }
}

/**
 * Queues a job for background processing. Returns immediately — the caller
 * (the POST /components route) never waits on generation, so closing the
 * extension popup right after creating the job has no effect on it.
 */
export function enqueueComponentJob(
  store: UnifiedComponentStore,
  generator: ComponentGenerator,
  payload: ComponentJobPayload,
): void {
  logLifecycle('generation_queued', { jobId: payload.jobId, target: payload.target });
  const q = getQueue();
  if (q) {
    // Explicit jobId (not BullMQ's auto-generated one) so a cancel request
    // for a still-queued job can look it up and remove it from the queue —
    // see cancelComponentJob below. attempts:1 is deliberate, not an
    // oversight: this job type must never auto-retry. A retry after a
    // MODEL_TIMEOUT or a genuine model error would start a second real
    // generation while the first's cleanup is still settling, risking a
    // second orphaned/overlapping Ollama call — exactly what end-to-end
    // cancellation exists to prevent. USER_CANCELLED must obviously never
    // retry either. A user who wants another attempt already has an
    // explicit, deliberate action for that: POST /components/:jobId/retry.
    void q.add('component-generation', payload, { jobId: payload.jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  // No Redis configured — still detached from the HTTP request via setImmediate,
  // still owned entirely by the long-lived API process. Development-only
  // fallback (see startComponentGenerationWorker) — production keeps BullMQ.
  setImmediate(() => {
    void processJob(store, generator, payload);
  });
}

export function startComponentGenerationWorker(
  store: UnifiedComponentStore,
  generator: ComponentGenerator,
): Worker<ComponentJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<ComponentJobPayload>(
    QUEUE_NAME,
    async (job: Job<ComponentJobPayload>) => {
      await processJob(store, generator, job.data);
    },
    {
      connection,
      concurrency: 2,
      // Comfortably above COMPONENT_GENERATION_TIMEOUT_MS: BullMQ's Worker
      // auto-renews a job's lock every lockDuration/2 while its processor
      // is still running, so a legitimately long generation never gets
      // marked stalled on its own — this is a defense-in-depth ceiling for
      // the case that renewal itself doesn't happen (the whole Node process,
      // not just this one job, wedged or crashed), so a genuinely dead
      // worker's job is detected and can be retried by a healthy worker
      // rather than sitting invisibly RUNNING forever in BullMQ's own state.
      lockDuration: COMPONENT_GENERATION_TIMEOUT_MS + 30_000,
      // A stalled job (lock expired without renewal — the owning worker
      // process died or froze) is requeued once, then marked failed rather
      // than stalling forever or retrying indefinitely.
      maxStalledCount: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`Component generation job ${job?.id} failed:`, err.message);
  });
  worker.on('stalled', (jobId) => {
    // The previous attempt's Node process died/froze mid-RUNNING without
    // ever reaching finalize() — its job record may still say RUNNING with
    // no further updates. BullMQ will redeliver it (up to maxStalledCount);
    // processJob()'s own terminal-status guard still protects against
    // double-completion if somehow both the dead and a new attempt run.
    logLifecycle('generation_worker_stalled', { jobId });
  });

  workerStarted = true;
  console.log('Component generation worker started');
  return worker;
}

/**
 * Requests cancellation of a QUEUED or RUNNING job. Idempotent and safe to
 * call multiple times or after the job has already finished — a job that is
 * already COMPLETED/FAILED/CANCELLED/BLOCKED_PRIVACY is returned unchanged,
 * never overwritten.
 *
 * Real cancellation, not merely a status flag: if the job is currently
 * RUNNING, the AbortController tied to it is aborted, which interrupts the
 * in-flight fetch to the AI Gateway (see component-generator.ts's
 * callGateway) — the AI Gateway's own outbound connection to the model
 * server is then also dropped. If the job is still QUEUED in Redis, it is
 * removed from the BullMQ queue so a worker never picks it up at all. If
 * neither applies (e.g. the job hasn't been registered yet in the tiny
 * window between creation and the no-Redis setImmediate firing), the
 * processJob() guard above still prevents it from ever overwriting the
 * CANCELLED status this function writes first.
 */
/**
 * Best-effort ownership check using the same optional client-supplied
 * ownerId the rest of this API already relies on — there is no real
 * authentication/session system in this application (see the project
 * audit), so this is not a substitute for one. If the job has no owner
 * recorded, or the requester didn't supply one, there's nothing to check
 * against, matching every other /components route's current behavior.
 */
export function canCancelJob(jobOwnerId: string | undefined, requestOwnerId: string | undefined): boolean {
  if (jobOwnerId && requestOwnerId && jobOwnerId !== requestOwnerId) return false;
  return true;
}

export async function cancelComponentJob(store: UnifiedComponentStore, jobId: string): Promise<ComponentGenerationJob | undefined> {
  const job = await store.getJobAsync(jobId);
  if (!job) return undefined;

  logLifecycle('generation_cancel_requested', { jobId, currentStatus: job.status });

  if (isTerminal(job.status)) {
    // Idempotent / safe against repeated requests: a job that's already
    // COMPLETED/FAILED/CANCELLED/TIMED_OUT/BLOCKED_PRIVACY is returned
    // unchanged, never overwritten — including never turning a COMPLETED
    // job back into CANCELLED.
    return job;
  }

  const control = jobControls.get(jobId);
  const wasQueued = !control;

  const cancelled: ComponentGenerationJob = {
    ...job,
    status: 'CANCELLED',
    error: 'Generation cancelled by user.',
    errorCategory: 'USER_CANCELLED',
    updatedAt: nowIso(),
  };
  store.saveJob(cancelled);
  const repo = store.getRepository();
  if (repo.isEnabled()) {
    await repo.updateStatus(jobId, 'CANCELLED', 'Generation cancelled by user.', 'USER_CANCELLED').catch(() => {});
  }

  if (control) {
    // RUNNING: abort the live AbortController — component-generator.ts's
    // in-flight fetch to the AI Router is interrupted, the AI Router's own
    // request.raw 'close' handler detects the resulting disconnect, and
    // aborts ITS in-flight fetch to Ollama in turn. finalize() (still
    // pending on that same generate() call) will log
    // generation_abort_completed once it actually settles — this function
    // returning does not itself mean the downstream chain has unwound yet.
    control.cancelReason = 'user';
    control.controller.abort();
    logLifecycle('generation_abort_requested', { jobId, reason: 'user' });
  } else if (wasQueued) {
    // QUEUED and not yet picked up: remove it from BullMQ before any worker
    // ever dequeues it — no AI call is ever made for this job.
    const q = getQueue();
    if (q) {
      try {
        const bullJob = await q.getJob(jobId);
        if (bullJob) await bullJob.remove();
      } catch {
        // Job may already be active, completed, or gone from the queue —
        // the processJob() start-of-run terminal-status guard is the
        // remaining safety net against it starting anyway.
      }
    }
  }

  return cancelled;
}
