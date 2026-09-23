import '../load-env.js';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import type { EmbeddingErrorCategory, RepositoryEmbeddingStatus } from '@origami/contracts';
import type { InsertEmbeddingInput } from '../db/repository-embedding-repository.js';
import { UnifiedRepositoryEmbeddingStore } from '../unified-repository-embedding-store.js';
import { UnifiedRepositoryStore } from '../unified-repository-store.js';
import { UnifiedRepositoryIndexStore } from '../unified-repository-index-store.js';
import { canAccessRepository } from '../repository-service.js';
import {
  AI_EMBED_BATCH_SIZE,
  EmbeddingProviderError,
  HttpEmbeddingProvider,
  type EmbeddingProvider,
} from '../repository-embedding-provider.js';
import { buildEmbeddingInput, exceedsMaxEmbeddingInputTokens } from '../repository-embedding-service.js';
import { getRedisConnection } from './website-scan-worker.js';

const QUEUE_NAME = 'repository-embedding-jobs';

/** Structured, non-sensitive lifecycle log — never embedding input, source code, or vectors themselves (see the module comment below). */
function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface RepositoryEmbeddingJobPayload {
  jobId: string;
  repositoryId: string;
  indexJobId: string;
  ownerId?: string;
}

interface JobControl {
  controller: AbortController;
  cancelReason: 'user' | null;
}

const jobControls = new Map<string, JobControl>();

let queue: Queue<RepositoryEmbeddingJobPayload> | null = null;
function getQueue(): Queue<RepositoryEmbeddingJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue<RepositoryEmbeddingJobPayload>(QUEUE_NAME, { connection });
  return queue;
}

let workerStarted = false;
export function isRepositoryEmbeddingWorkerRunning(): boolean {
  return workerStarted;
}

const TERMINAL_STATUSES: RepositoryEmbeddingStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
function isTerminal(status: RepositoryEmbeddingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Injectable purely for deterministic testing (a fake provider with no network dependency) — production always uses HttpEmbeddingProvider, which talks only to the AI Router's dedicated /embed route. Mirrors repository-clone-worker.ts's ProcessJobDeps / repository-index-worker.ts's IndexProcessJobDeps. */
export interface EmbeddingProcessJobDeps {
  provider: EmbeddingProvider;
}

interface BatchOutcome {
  status: RepositoryEmbeddingStatus;
  error?: string;
  errorCategory?: EmbeddingErrorCategory;
}

/**
 * Runs one embedding job to completion. Never logs embedding input, source
 * code, or complete vectors — only chunk counts, batch counts, durations,
 * and the model/dimensions/error-category identifiers (see logLifecycle
 * calls below). The provider (HttpEmbeddingProvider in production) is the
 * only thing that ever sees the constructed embedding text, and even it
 * only relays to the AI Router's /embed route, which scrubs it again before
 * ever reaching a model server (see services/ai-router/src/index.ts).
 */
export async function processJob(
  embeddingStore: UnifiedRepositoryEmbeddingStore,
  repositoryStore: UnifiedRepositoryStore,
  indexStore: UnifiedRepositoryIndexStore,
  payload: RepositoryEmbeddingJobPayload,
  deps: EmbeddingProcessJobDeps = { provider: new HttpEmbeddingProvider() },
): Promise<void> {
  const existing = await embeddingStore.getByIdAsync(payload.jobId);
  if (existing && isTerminal(existing.status)) return;

  const controller = new AbortController();
  const control: JobControl = { controller, cancelReason: null };
  jobControls.set(payload.jobId, control);

  const startedAt = Date.now();
  let totalChunks = 0;
  let embeddedChunks = 0;
  let skippedChunks = 0;
  let failedChunks = 0;
  let batches = 0;
  let dimensions: number | undefined;
  let commitSha: string | undefined;

  const finalize = async (outcome: BatchOutcome) => {
    const finalStatus = control.cancelReason === 'user' ? 'CANCELLED' : outcome.status;
    const finalError = control.cancelReason === 'user' ? 'Embedding cancelled by user.' : outcome.error;
    const finalCategory: EmbeddingErrorCategory | undefined = control.cancelReason === 'user' ? 'EMBEDDING_CANCELLED' : outcome.errorCategory;

    if (finalStatus !== 'COMPLETED') {
      // Never leave a partial embedding set in a state EMBEDDINGS_READY
      // could imply is complete — see the Phase 4 report's cleanup policy.
      await embeddingStore.deleteEmbeddingsForJob(payload.jobId);
    }

    await embeddingStore.complete(payload.jobId, {
      status: finalStatus,
      dimensions,
      totalChunks,
      embeddedChunks,
      skippedChunks,
      failedChunks,
      error: finalError,
      errorCategory: finalCategory,
    });
    await repositoryStore.updateStatus(payload.repositoryId, finalStatus === 'COMPLETED' ? 'EMBEDDINGS_READY' : 'READY_FOR_SEARCH');

    const durationMs = Date.now() - startedAt;
    const eventByStatus: Record<RepositoryEmbeddingStatus, string> = {
      QUEUED: 'repository_embedding_queued',
      RUNNING: 'repository_embedding_running',
      COMPLETED: 'repository_embedding_completed',
      FAILED: 'repository_embedding_failed',
      CANCELLED: 'repository_embedding_cancelled',
    };
    logLifecycle(eventByStatus[finalStatus], {
      repositoryId: payload.repositoryId,
      jobId: payload.jobId,
      commitSha,
      status: finalStatus,
      model: deps.provider.model,
      dimensions,
      totalChunks,
      batches,
      durationMs,
      embeddedChunks,
      skippedChunks,
      failedChunks,
      errorCategory: finalCategory,
    });
  };

  try {
    // 1. Validate repository.
    const repository = await repositoryStore.getByIdAsync(payload.repositoryId);
    if (!repository) {
      await finalize({ status: 'FAILED', error: 'Repository not found.', errorCategory: 'EMBEDDING_JOB_ERROR' });
      return;
    }

    // 2. Validate owner (best-effort, no real auth — see the Repository Feature Audit).
    if (!canAccessRepository(repository.userId, payload.ownerId)) {
      await finalize({ status: 'FAILED', error: 'You do not have permission to embed this repository.', errorCategory: 'EMBEDDING_JOB_ERROR' });
      return;
    }

    // 3. Find the target index job and 4. verify it completed successfully.
    const indexJob = await indexStore.getByIdAsync(payload.indexJobId);
    if (!indexJob || indexJob.status !== 'COMPLETED') {
      await finalize({ status: 'FAILED', error: 'No successful repository index is available to embed.', errorCategory: 'EMBEDDING_JOB_ERROR' });
      return;
    }
    commitSha = indexJob.commitSha;

    // Model verification — never silently substitute another model (see
    // the Phase 4 report's "Model Verification" section).
    const availability = await deps.provider.isAvailable();
    if (!availability.available) {
      const reason = !availability.reachable
        ? `The embedding model server is unreachable${availability.error ? `: ${availability.error}` : '.'}`
        : `The configured embedding model "${deps.provider.model}" is not available on the model server.`;
      await finalize({ status: 'FAILED', error: reason, errorCategory: 'EMBEDDING_PROVIDER_UNAVAILABLE' });
      return;
    }

    await embeddingStore.markRunning(payload.jobId);
    await repositoryStore.updateStatus(payload.repositoryId, 'EMBEDDING');
    logLifecycle('repository_embedding_started', { repositoryId: payload.repositoryId, jobId: payload.jobId, commitSha, model: deps.provider.model });

    // 5. Read code chunks persisted by Phase 3 for this exact index job.
    const chunks = await indexStore.getChunksForJobAsync(payload.indexJobId);
    totalChunks = chunks.length;

    if (totalChunks === 0) {
      await finalize({ status: 'COMPLETED' });
      return;
    }

    // 6. Determine which chunks require embeddings — content-hash reuse,
    // scoped to (repository, commit, model): the same content already
    // embedded for this exact commit and model is never re-embedded.
    const contentHashes = chunks.map((c) => c.contentHash);
    const alreadyCovered = await embeddingStore.findExistingByContentHashesAsync(payload.repositoryId, commitSha, deps.provider.model, contentHashes);

    const candidates: Array<{ chunkId: string; contentHash: string; input: string }> = [];
    for (const chunk of chunks) {
      if (alreadyCovered.has(chunk.contentHash)) continue;
      const input = buildEmbeddingInput({
        filePath: chunk.filePath,
        language: chunk.language,
        symbol: chunk.symbol,
        symbolType: chunk.symbolType,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
      });
      if (exceedsMaxEmbeddingInputTokens(input)) {
        skippedChunks += 1;
        continue;
      }
      candidates.push({ chunkId: chunk.id, contentHash: chunk.contentHash, input });
    }

    // 7/8/9. Generate embeddings in bounded batches, validate dimensions,
    // persist — never the whole repository in one request.
    for (let i = 0; i < candidates.length; i += AI_EMBED_BATCH_SIZE) {
      if (control.cancelReason) break;
      const batch = candidates.slice(i, i + AI_EMBED_BATCH_SIZE);

      let result;
      try {
        result = await deps.provider.embedBatch(batch.map((b) => b.input), control.controller.signal);
      } catch (error) {
        if (control.cancelReason) break;
        if (error instanceof EmbeddingProviderError) {
          await finalize({ status: 'FAILED', error: error.message, errorCategory: error.category });
          return;
        }
        throw error;
      }
      batches += 1;

      // Validate dimensions before persistence — reject, never truncate/pad
      // (see the Phase 4 report's "Vector Dimension" section).
      if (dimensions === undefined) dimensions = result.dimensions;
      if (result.dimensions !== dimensions) {
        await finalize({
          status: 'FAILED',
          error: `Embedding dimension mismatch: expected ${dimensions}, got ${result.dimensions}.`,
          errorCategory: 'EMBEDDING_DIMENSION_MISMATCH',
        });
        return;
      }

      const insertBatch: InsertEmbeddingInput[] = [];
      batch.forEach((candidate, index) => {
        const vector = result.vectors[index];
        if (!Array.isArray(vector) || vector.length !== dimensions) {
          failedChunks += 1;
          return;
        }
        insertBatch.push({
          id: randomUUID(),
          repositoryId: payload.repositoryId,
          embeddingJobId: payload.jobId,
          chunkId: candidate.chunkId,
          commitSha: commitSha!,
          model: result.model,
          dimensions: dimensions!,
          contentHash: candidate.contentHash,
          vector,
        });
        alreadyCovered.add(candidate.contentHash);
      });

      if (insertBatch.length > 0) await embeddingStore.insertEmbeddingsBatch(insertBatch);
    }

    embeddedChunks = chunks.filter((c) => alreadyCovered.has(c.contentHash)).length;

    if (control.cancelReason) {
      await finalize({ status: 'CANCELLED' });
      return;
    }

    // Completion policy (see the Phase 4 report): every chunk must be
    // accounted for as either embedded or legitimately skipped, and there
    // must be zero failures — a partial/incomplete run never becomes
    // EMBEDDINGS_READY.
    if (failedChunks > 0 || embeddedChunks + skippedChunks !== totalChunks) {
      await finalize({
        status: 'FAILED',
        error: `Embedding coverage incomplete: ${embeddedChunks}/${totalChunks} embedded, ${skippedChunks} skipped, ${failedChunks} failed.`,
        errorCategory: 'EMBEDDING_JOB_ERROR',
      });
      return;
    }

    await finalize({ status: 'COMPLETED' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Repository embedding failed';
    await finalize({ status: 'FAILED', error: message.length > 300 ? `${message.slice(0, 300)}…` : message, errorCategory: 'EMBEDDING_JOB_ERROR' });
  } finally {
    jobControls.delete(payload.jobId);
  }
}

export function enqueueRepositoryEmbeddingJob(
  embeddingStore: UnifiedRepositoryEmbeddingStore,
  repositoryStore: UnifiedRepositoryStore,
  indexStore: UnifiedRepositoryIndexStore,
  payload: RepositoryEmbeddingJobPayload,
): void {
  logLifecycle('repository_embedding_job_queued', { repositoryId: payload.repositoryId, jobId: payload.jobId });
  const q = getQueue();
  if (q) {
    void q.add('repository-embedding', payload, { jobId: payload.jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  setImmediate(() => {
    void processJob(embeddingStore, repositoryStore, indexStore, payload);
  });
}

export function startRepositoryEmbeddingWorker(
  embeddingStore: UnifiedRepositoryEmbeddingStore,
  repositoryStore: UnifiedRepositoryStore,
  indexStore: UnifiedRepositoryIndexStore,
): Worker<RepositoryEmbeddingJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<RepositoryEmbeddingJobPayload>(
    QUEUE_NAME,
    async (job: Job<RepositoryEmbeddingJobPayload>) => {
      await processJob(embeddingStore, repositoryStore, indexStore, job.data);
    },
    // Concurrency 1, deliberately conservative — this worker should not
    // compete aggressively with Screenshot -> Code's GPU usage (see the
    // Phase 4 report's "GPU Resource Contention" section). Per-job batch
    // concurrency, not worker-level job concurrency, is what
    // AI_EMBED_CONCURRENCY governs (see repository-embedding-provider.ts).
    { connection, concurrency: 1, maxStalledCount: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Repository embedding job ${job?.id} failed:`, err.message);
  });
  worker.on('stalled', (jobId) => {
    logLifecycle('repository_embedding_worker_stalled', { jobId });
  });

  workerStarted = true;
  console.log('Repository embedding worker started');
  return worker;
}

/**
 * Requests cancellation of a QUEUED or RUNNING embedding job — same shape
 * as the Phase 2/3 workers' cancel functions: idempotent, persists
 * CANCELLED immediately (authoritative via control.cancelReason), and
 * either aborts the live AbortController (which propagates to the
 * in-flight HTTP call to the AI Router's /embed route, which in turn
 * aborts its own downstream call to the model server — see
 * HttpEmbeddingProvider.embedBatch and the /embed route's reply.raw 'close'
 * handler) or removes the still-QUEUED BullMQ job.
 */
export async function cancelRepositoryEmbeddingJob(
  embeddingStore: UnifiedRepositoryEmbeddingStore,
  repositoryStore: UnifiedRepositoryStore,
  jobId: string,
) {
  const job = await embeddingStore.getByIdAsync(jobId);
  if (!job) return undefined;

  logLifecycle('repository_embedding_cancel_requested', { jobId, currentStatus: job.status });

  if (isTerminal(job.status)) return job;

  const control = jobControls.get(jobId);
  const wasQueued = !control;

  await embeddingStore.complete(jobId, { status: 'CANCELLED', error: 'Embedding cancelled by user.', errorCategory: 'EMBEDDING_CANCELLED' });
  await repositoryStore.updateStatus(job.repositoryId, 'READY_FOR_SEARCH');

  if (control) {
    control.cancelReason = 'user';
    control.controller.abort();
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

  return { ...job, status: 'CANCELLED' as const, error: 'Embedding cancelled by user.', errorCategory: 'EMBEDDING_CANCELLED' as const };
}
