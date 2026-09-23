import '../load-env.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import type { RepositoryCloneJob, RepositoryCloneStatus, RepositoryDiscoveryMetadata } from '@origami/contracts';
import { UnifiedRepositoryCloneStore } from '../unified-repository-clone-store.js';
import { UnifiedRepositoryStore } from '../unified-repository-store.js';
import {
  REPOSITORY_CLONE_TIMEOUT_MS,
  REPOSITORY_MAX_FILE_COUNT,
  REPOSITORY_MAX_FILE_SIZE_BYTES,
  REPOSITORY_MAX_TOTAL_SIZE_BYTES,
  resolveCloneDir,
} from '../repository-clone-service.js';
import { parseRepositoryUrl, validateBranch } from '../repository-service.js';
import { GitCloneError, cloneRepository, getCommitSha, sanitizeGitError } from '../repository-git.js';
import { RepositoryLimitExceededError, discoverRepository } from '../repository-discovery.js';
import { getRedisConnection } from './website-scan-worker.js';

const QUEUE_NAME = 'repository-clone-jobs';

/** Structured, non-sensitive lifecycle log — never repository file contents, credentials, or raw Git stderr (see sanitizeGitError). Mirrors component-generation-worker.ts's logLifecycle. */
function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface RepositoryCloneJobPayload {
  jobId: string;
  repositoryId: string;
  ownerId?: string;
  repoUrl: string;
  branch: string;
}

interface JobControl {
  controller: AbortController;
  cancelReason: 'user' | 'timeout' | null;
}

/** Live AbortControllers for jobs currently being processed, keyed by jobId — see component-generation-worker.ts's identical jobControls for why this is necessarily in-memory only. */
const jobControls = new Map<string, JobControl>();

let queue: Queue<RepositoryCloneJobPayload> | null = null;

function getQueue(): Queue<RepositoryCloneJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue<RepositoryCloneJobPayload>(QUEUE_NAME, { connection });
  }
  return queue;
}

let workerStarted = false;
export function isRepositoryCloneWorkerRunning(): boolean {
  return workerStarted;
}

const TERMINAL_STATUSES: RepositoryCloneStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
function isTerminal(status: RepositoryCloneStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

async function removeCloneDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    logLifecycle('repository_clone_cleanup_failed', { dir, error: error instanceof Error ? error.message : String(error) });
  }
}

interface JobOutcome {
  status: RepositoryCloneStatus;
  commitSha?: string;
  discovery?: RepositoryDiscoveryMetadata;
  error?: string;
}

/**
 * The actual `git clone`/`rev-parse`/filesystem-walk implementations, as an
 * injectable seam purely for deterministic testing — production code always
 * uses the real defaults below. Crucially, URL/branch validation (via
 * parseRepositoryUrl/validateBranch, see processJob's `try` block) is NOT
 * part of this seam and is never mocked in tests: every job, real or test,
 * goes through the real host-allowlist and branch-charset checks before any
 * of these functions are ever called.
 */
export interface ProcessJobDeps {
  clone: typeof cloneRepository;
  getSha: typeof getCommitSha;
  discover: typeof discoverRepository;
}

const defaultDeps: ProcessJobDeps = { clone: cloneRepository, getSha: getCommitSha, discover: discoverRepository };

/** Runs one clone+discovery job to completion and persists the result. Mirrors component-generation-worker.ts's processJob/finalize shape closely: the same "server-side control state always wins" rule applies to cancellation/timeout racing against a since-completed outcome. */
export async function processJob(
  cloneStore: UnifiedRepositoryCloneStore,
  repositoryStore: UnifiedRepositoryStore,
  payload: RepositoryCloneJobPayload,
  deps: ProcessJobDeps = defaultDeps,
): Promise<void> {
  const existing = await cloneStore.getByIdAsync(payload.jobId);
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
  }, REPOSITORY_CLONE_TIMEOUT_MS);

  let cloneDir: string | undefined;

  const finalize = async (outcome: JobOutcome) => {
    let status = outcome.status;
    let error = outcome.error;
    if (control.cancelReason === 'user') {
      status = 'CANCELLED';
      error = 'Clone cancelled by user.';
    } else if (control.cancelReason === 'timeout') {
      status = 'TIMED_OUT';
      error = `Clone timed out after ${Math.round(REPOSITORY_CLONE_TIMEOUT_MS / 1000)}s.`;
    }

    const durationMs = Date.now() - startedAt;
    const persisted = status === 'COMPLETED' ? outcome : { ...outcome, commitSha: undefined, discovery: undefined };
    await cloneStore.complete(payload.jobId, { status, commitSha: persisted.commitSha, discovery: persisted.discovery, error });

    // Repository-level state (distinct from this job's own status) — a
    // successful clone makes the repository ready for Phase 3; a cancelled
    // clone simply reverts to CONNECTED so the user can retry; anything else
    // terminal-but-not-COMPLETED is a real failure.
    if (status === 'COMPLETED') {
      await repositoryStore.updateStatus(payload.repositoryId, 'READY_FOR_INDEXING');
    } else if (status === 'CANCELLED') {
      await repositoryStore.updateStatus(payload.repositoryId, 'CONNECTED');
    } else {
      await repositoryStore.updateStatus(payload.repositoryId, 'FAILED');
    }

    if (cloneDir && status !== 'COMPLETED') {
      await removeCloneDir(cloneDir);
    }

    const eventByStatus: Partial<Record<RepositoryCloneStatus, string>> = {
      COMPLETED: 'repository_clone_completed',
      FAILED: 'repository_clone_failed',
      CANCELLED: 'repository_clone_cancelled',
      TIMED_OUT: 'repository_clone_timeout',
    };
    logLifecycle(eventByStatus[status] ?? 'repository_clone_failed', {
      repositoryId: payload.repositoryId,
      jobId: payload.jobId,
      status,
      durationMs,
      commitSha: persisted.commitSha,
      fileCount: persisted.discovery?.fileCount,
      directoryCount: persisted.discovery?.directoryCount,
      totalSizeBytes: persisted.discovery?.totalSizeBytes,
    });
  };

  try {
    cloneDir = resolveCloneDir(payload.repositoryId, payload.jobId);

    // Defense-in-depth re-validation: Phase 1 already enforces the host
    // allowlist and credential-free/HTTPS-only rules at connect time, and
    // validateBranch's charset check at both connect and clone time — this
    // repeats that check immediately before handing either value to git,
    // rather than trusting that a stored row can never diverge from what
    // was validated when it was written.
    const parsedUrl = parseRepositoryUrl(payload.repoUrl);
    const parsedBranch = validateBranch(payload.branch);
    if (!parsedUrl.ok) throw new Error(parsedUrl.error);
    if (!parsedBranch.ok) throw new Error(parsedBranch.error);

    await fs.mkdir(path.dirname(cloneDir), { recursive: true });
    await cloneStore.markRunning(payload.jobId, cloneDir);
    await repositoryStore.updateStatus(payload.repositoryId, 'CLONING');
    logLifecycle('repository_clone_started', { repositoryId: payload.repositoryId, jobId: payload.jobId });

    await deps.clone(parsedUrl.value.normalizedUrl, parsedBranch.value, cloneDir, controller.signal);

    if (controller.signal.aborted) {
      throw new GitCloneError('Clone aborted', 'aborted');
    }

    const commitSha = await deps.getSha(cloneDir, controller.signal);
    const discovery = deps.discover(cloneDir, {
      maxFileCount: REPOSITORY_MAX_FILE_COUNT,
      maxTotalSizeBytes: REPOSITORY_MAX_TOTAL_SIZE_BYTES,
      maxFileSizeBytes: REPOSITORY_MAX_FILE_SIZE_BYTES,
    });

    await finalize({ status: 'COMPLETED', commitSha, discovery });
  } catch (error) {
    if (control.cancelReason) {
      // finalize() turns this into CANCELLED/TIMED_OUT regardless of the
      // underlying error text — see its "server-side state wins" comment.
      await finalize({ status: 'FAILED' });
    } else if (error instanceof RepositoryLimitExceededError) {
      await finalize({ status: 'FAILED', error: error.message });
    } else if (error instanceof GitCloneError) {
      await finalize({ status: 'FAILED', error: error.message });
    } else {
      const message = error instanceof Error ? sanitizeGitError(error.message) : 'Repository clone failed';
      await finalize({ status: 'FAILED', error: message });
    }
  } finally {
    clearTimeout(timeoutTimer);
    jobControls.delete(payload.jobId);
  }
}

/** Queues a job for background processing. Returns immediately — POST /repositories/:id/clone never waits on the clone itself. */
export function enqueueRepositoryCloneJob(
  cloneStore: UnifiedRepositoryCloneStore,
  repositoryStore: UnifiedRepositoryStore,
  payload: RepositoryCloneJobPayload,
): void {
  logLifecycle('repository_clone_queued', { repositoryId: payload.repositoryId, jobId: payload.jobId });
  const q = getQueue();
  if (q) {
    // attempts:1 — a clone failure should never auto-retry (mirrors
    // component-generation-worker.ts's identical reasoning): a retry would
    // start a second real clone while the first's cleanup may still be
    // settling, and a user-initiated retry already has an explicit action
    // (re-POST /repositories/:id/clone once the failed job is terminal).
    void q.add('repository-clone', payload, { jobId: payload.jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  // No Redis configured — still detached from the HTTP request via setImmediate.
  setImmediate(() => {
    void processJob(cloneStore, repositoryStore, payload);
  });
}

export function startRepositoryCloneWorker(
  cloneStore: UnifiedRepositoryCloneStore,
  repositoryStore: UnifiedRepositoryStore,
): Worker<RepositoryCloneJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<RepositoryCloneJobPayload>(
    QUEUE_NAME,
    async (job: Job<RepositoryCloneJobPayload>) => {
      await processJob(cloneStore, repositoryStore, job.data);
    },
    {
      connection,
      concurrency: 2,
      lockDuration: REPOSITORY_CLONE_TIMEOUT_MS + 30_000,
      maxStalledCount: 1,
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`Repository clone job ${job?.id} failed:`, err.message);
  });
  worker.on('stalled', (jobId) => {
    logLifecycle('repository_clone_worker_stalled', { jobId });
  });

  workerStarted = true;
  console.log('Repository clone worker started');
  return worker;
}

/**
 * Requests cancellation of a QUEUED or RUNNING clone job — same shape as
 * component-generation-worker.ts's cancelComponentJob: idempotent, persists
 * CANCELLED immediately (authoritative via control.cancelReason even if the
 * in-flight git process happens to finish a split second later), aborts the
 * live AbortController (which terminates the underlying `git` child process,
 * see repository-git.ts's `run`) if RUNNING, or removes the BullMQ job if
 * still QUEUED and unpicked.
 */
export async function cancelRepositoryCloneJob(
  cloneStore: UnifiedRepositoryCloneStore,
  repositoryStore: UnifiedRepositoryStore,
  jobId: string,
): Promise<RepositoryCloneJob | undefined> {
  const job = await cloneStore.getByIdAsync(jobId);
  if (!job) return undefined;

  logLifecycle('repository_clone_cancel_requested', { jobId, currentStatus: job.status });

  if (isTerminal(job.status)) {
    return job;
  }

  const control = jobControls.get(jobId);
  const wasQueued = !control;

  await cloneStore.complete(jobId, { status: 'CANCELLED', error: 'Clone cancelled by user.' });
  await repositoryStore.updateStatus(job.repositoryId, 'CONNECTED');

  if (control) {
    control.cancelReason = 'user';
    control.controller.abort();
    logLifecycle('repository_clone_abort_requested', { jobId });
  } else if (wasQueued) {
    const q = getQueue();
    if (q) {
      try {
        const bullJob = await q.getJob(jobId);
        if (bullJob) await bullJob.remove();
      } catch {
        // Job may already be active/completed/gone — processJob()'s
        // start-of-run terminal-status guard is the remaining safety net.
      }
    }
  }

  return { ...job, status: 'CANCELLED', error: 'Clone cancelled by user.' };
}
