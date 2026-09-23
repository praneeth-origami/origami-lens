import '../load-env.js';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import type { RepositoryIndexStatus } from '@origami/contracts';
import type { InsertCodeChunkInput } from '../db/repository-index-repository.js';
import { UnifiedRepositoryIndexStore } from '../unified-repository-index-store.js';
import { UnifiedRepositoryStore } from '../unified-repository-store.js';
import { UnifiedRepositoryCloneStore } from '../unified-repository-clone-store.js';
import { envInt, isPathInside, resolveCloneDir, REPOSITORY_CLONE_ROOT, REPOSITORY_MAX_FILE_SIZE_BYTES } from '../repository-clone-service.js';
import { iterateRepositoryFiles, type DiscoveredFileEntry } from '../repository-discovery.js';
import { processRepositoryFile, type ProcessedFileResult } from '../repository-index-service.js';
import { getRedisConnection } from './website-scan-worker.js';

const QUEUE_NAME = 'repository-index-jobs';

/** Files are parsed in bounded concurrent batches — parsing/IO for each file is independent, but persistence and cancellation checks happen sequentially between batches (a "safe boundary"). A conservative default: Tree-sitter parsing is CPU-bound and synchronous, so this mainly overlaps disk I/O rather than parallelizing parse work itself. */
const REPOSITORY_INDEX_CONCURRENCY = envInt('REPOSITORY_INDEX_CONCURRENCY', 4);
/** Chunk rows are inserted in bounded batches rather than one at a time or all at once — see the module comment on memory management. */
const CHUNK_INSERT_BATCH_SIZE = 200;

function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface RepositoryIndexJobPayload {
  jobId: string;
  repositoryId: string;
  cloneJobId: string;
  ownerId?: string;
}

interface JobControl {
  controller: AbortController;
  cancelReason: 'user' | null;
}

const jobControls = new Map<string, JobControl>();

let queue: Queue<RepositoryIndexJobPayload> | null = null;
function getQueue(): Queue<RepositoryIndexJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue<RepositoryIndexJobPayload>(QUEUE_NAME, { connection });
  return queue;
}

let workerStarted = false;
export function isRepositoryIndexWorkerRunning(): boolean {
  return workerStarted;
}

const TERMINAL_STATUSES: RepositoryIndexStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
function isTerminal(status: RepositoryIndexStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Injectable purely for deterministic testing (e.g. a smaller/faster processFile) — production always uses the real defaults. Mirrors repository-clone-worker.ts's ProcessJobDeps. */
export interface IndexProcessJobDeps {
  iterateFiles: typeof iterateRepositoryFiles;
  processFile: typeof processRepositoryFile;
}
const defaultDeps: IndexProcessJobDeps = { iterateFiles: iterateRepositoryFiles, processFile: processRepositoryFile };

async function runBoundedConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function draftToInsertChunk(
  chunk: ProcessedFileResult['chunks'][number],
  context: { indexJobId: string; repositoryId: string; commitSha: string; fileId: string },
): InsertCodeChunkInput {
  return {
    id: randomUUID(),
    indexJobId: context.indexJobId,
    repositoryId: context.repositoryId,
    commitSha: context.commitSha,
    fileId: context.fileId,
    filePath: chunk.filePath,
    language: chunk.language,
    symbol: chunk.symbol,
    symbolType: chunk.symbolType,
    parentSymbol: chunk.parentSymbol,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    startColumn: chunk.startColumn,
    endColumn: chunk.endColumn,
    isExported: chunk.isExported,
    content: chunk.content,
    contentHash: chunk.contentHash,
    chunkKey: chunk.chunkKey,
  };
}

/**
 * Runs one index job to completion. Never executes any file it reads —
 * every file goes only through processRepositoryFile (safety checks +
 * Tree-sitter parsing), never through require/import/eval/child_process.
 * Cancellation is checked between batches of files (a safe boundary, per
 * the spec) rather than being able to interrupt a single in-flight parse —
 * Tree-sitter's synchronous WASM parse of one file is not itself
 * interruptible, but is bounded by REPOSITORY_MAX_FILE_SIZE_BYTES so no
 * single file can make that boundary far away.
 */
export async function processJob(
  indexStore: UnifiedRepositoryIndexStore,
  repositoryStore: UnifiedRepositoryStore,
  cloneStore: UnifiedRepositoryCloneStore,
  payload: RepositoryIndexJobPayload,
  deps: IndexProcessJobDeps = defaultDeps,
): Promise<void> {
  const existing = await indexStore.getByIdAsync(payload.jobId);
  if (existing && isTerminal(existing.status)) return;

  const controller = new AbortController();
  const control: JobControl = { controller, cancelReason: null };
  jobControls.set(payload.jobId, control);

  const startedAt = Date.now();
  let filesIndexed = 0;
  let filesSkipped = 0;
  let chunksCreated = 0;

  const finalize = async (status: RepositoryIndexStatus, error?: string) => {
    const finalStatus = control.cancelReason === 'user' ? 'CANCELLED' : status;
    const finalError = control.cancelReason === 'user' ? 'Indexing cancelled by user.' : error;

    if (finalStatus !== 'COMPLETED') {
      // Never leave a partial index in a state Phase 4 could search —
      // see the Phase 3 report's cleanup policy.
      await indexStore.deletePartialIndex(payload.jobId);
    }

    await indexStore.complete(payload.jobId, { status: finalStatus, filesIndexed, filesSkipped, chunksCreated, error: finalError });
    await repositoryStore.updateStatus(payload.repositoryId, finalStatus === 'COMPLETED' ? 'READY_FOR_SEARCH' : 'READY_FOR_INDEXING');

    const durationMs = Date.now() - startedAt;
    const eventByStatus: Record<RepositoryIndexStatus, string> = {
      QUEUED: 'repository_index_queued',
      RUNNING: 'repository_index_running',
      COMPLETED: 'repository_index_completed',
      FAILED: 'repository_index_failed',
      CANCELLED: 'repository_index_cancelled',
    };
    logLifecycle(eventByStatus[finalStatus], {
      repositoryId: payload.repositoryId,
      jobId: payload.jobId,
      status: finalStatus,
      durationMs,
      filesIndexed,
      filesSkipped,
      chunksCreated,
    });
  };

  try {
    const cloneJob = await cloneStore.getByIdAsync(payload.cloneJobId);
    if (!cloneJob || cloneJob.status !== 'COMPLETED' || !cloneJob.commitSha) {
      await finalize('FAILED', 'No successful clone is available to index.');
      return;
    }

    const cloneDir = resolveCloneDir(payload.repositoryId, payload.cloneJobId);
    if (!isPathInside(REPOSITORY_CLONE_ROOT, cloneDir)) {
      // Cannot happen given resolveCloneDir's own construction — asserted
      // anyway per the spec's explicit precondition list.
      await finalize('FAILED', 'Clone path is not within the configured repository root.');
      return;
    }
    if (!fs.existsSync(cloneDir)) {
      await finalize('FAILED', 'Clone directory no longer exists on disk.');
      return;
    }

    const commitSha = cloneJob.commitSha;
    await indexStore.markRunning(payload.jobId);
    await repositoryStore.updateStatus(payload.repositoryId, 'INDEXING');
    logLifecycle('repository_index_started', { repositoryId: payload.repositoryId, jobId: payload.jobId, commitSha });

    const limits = { maxFileSizeBytes: REPOSITORY_MAX_FILE_SIZE_BYTES };
    let batch: DiscoveredFileEntry[] = [];

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const results = await runBoundedConcurrent(batch, REPOSITORY_INDEX_CONCURRENCY, (entry) =>
        deps.processFile(entry, { repositoryId: payload.repositoryId, commitSha }, limits),
      );

      let chunkInsertBuffer: InsertCodeChunkInput[] = [];
      for (const result of results) {
        const fileId = randomUUID();
        await indexStore.insertFile({
          id: fileId,
          indexJobId: payload.jobId,
          repositoryId: payload.repositoryId,
          commitSha,
          filePath: result.relativePath,
          language: result.language,
          fileSizeBytes: result.fileSizeBytes,
          contentHash: result.contentHash,
          status: result.status,
          error: result.error,
        });

        if (result.status === 'INDEXED') filesIndexed += 1;
        else filesSkipped += 1;

        for (const chunk of result.chunks) {
          chunkInsertBuffer.push(draftToInsertChunk(chunk, { indexJobId: payload.jobId, repositoryId: payload.repositoryId, commitSha, fileId }));
          chunksCreated += 1;
          if (chunkInsertBuffer.length >= CHUNK_INSERT_BATCH_SIZE) {
            await indexStore.insertChunksBatch(chunkInsertBuffer);
            chunkInsertBuffer = [];
          }
        }
      }
      if (chunkInsertBuffer.length > 0) await indexStore.insertChunksBatch(chunkInsertBuffer);
      batch = [];
    };

    for (const entry of deps.iterateFiles(cloneDir)) {
      batch.push(entry);
      if (batch.length >= REPOSITORY_INDEX_CONCURRENCY) {
        await flushBatch();
        // Safe boundary — between batches, never mid-file.
        if (control.cancelReason) break;
      }
    }
    if (!control.cancelReason) await flushBatch();

    await finalize(control.cancelReason ? 'CANCELLED' : 'COMPLETED');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Repository indexing failed';
    await finalize('FAILED', message.length > 300 ? `${message.slice(0, 300)}…` : message);
  } finally {
    jobControls.delete(payload.jobId);
  }
}

export function enqueueRepositoryIndexJob(
  indexStore: UnifiedRepositoryIndexStore,
  repositoryStore: UnifiedRepositoryStore,
  cloneStore: UnifiedRepositoryCloneStore,
  payload: RepositoryIndexJobPayload,
): void {
  logLifecycle('repository_index_queued', { repositoryId: payload.repositoryId, jobId: payload.jobId });
  const q = getQueue();
  if (q) {
    void q.add('repository-index', payload, { jobId: payload.jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  setImmediate(() => {
    void processJob(indexStore, repositoryStore, cloneStore, payload);
  });
}

export function startRepositoryIndexWorker(
  indexStore: UnifiedRepositoryIndexStore,
  repositoryStore: UnifiedRepositoryStore,
  cloneStore: UnifiedRepositoryCloneStore,
): Worker<RepositoryIndexJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<RepositoryIndexJobPayload>(
    QUEUE_NAME,
    async (job: Job<RepositoryIndexJobPayload>) => {
      await processJob(indexStore, repositoryStore, cloneStore, job.data);
    },
    { connection, concurrency: 1, maxStalledCount: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Repository index job ${job?.id} failed:`, err.message);
  });
  worker.on('stalled', (jobId) => {
    logLifecycle('repository_index_worker_stalled', { jobId });
  });

  workerStarted = true;
  console.log('Repository index worker started');
  return worker;
}

/**
 * Requests cancellation of a QUEUED or RUNNING index job — same shape as
 * the Phase 2 clone worker's cancel function: idempotent, persists
 * CANCELLED immediately (authoritative via control.cancelReason even if the
 * current batch happens to finish a split second later), and either aborts
 * the live control (checked at the next between-batch safe boundary) or
 * removes the still-QUEUED BullMQ job. This function itself does not delete
 * any partial index rows — that always happens inside processJob's own
 * finalize(), to avoid a race between an optimistic delete here and rows
 * the running job might still be about to write.
 */
export async function cancelRepositoryIndexJob(
  indexStore: UnifiedRepositoryIndexStore,
  repositoryStore: UnifiedRepositoryStore,
  jobId: string,
) {
  const job = await indexStore.getByIdAsync(jobId);
  if (!job) return undefined;

  logLifecycle('repository_index_cancel_requested', { jobId, currentStatus: job.status });

  if (isTerminal(job.status)) return job;

  const control = jobControls.get(jobId);
  const wasQueued = !control;

  await indexStore.complete(jobId, { status: 'CANCELLED', error: 'Indexing cancelled by user.' });
  await repositoryStore.updateStatus(job.repositoryId, 'READY_FOR_INDEXING');

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

  return { ...job, status: 'CANCELLED' as const, error: 'Indexing cancelled by user.' };
}
