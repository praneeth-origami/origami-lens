import '../load-env.js';
import { Queue, Worker, type Job } from 'bullmq';
import type { RepositoryIssueAnalysisStatus } from '@origami/contracts';
import { UnifiedRepositoryIssueStore } from '../unified-repository-issue-store.js';
import { UnifiedRepositoryIssueAnalysisStore } from '../unified-repository-issue-analysis-store.js';
import { UnifiedRepositoryIndexStore } from '../unified-repository-index-store.js';
import { runIssueAnalysis, IssueAnalysisError, type RunIssueAnalysisDeps } from '../repository-issue-analysis-service.js';
import { getRedisConnection } from './website-scan-worker.js';

/**
 * Isolated queue — never repository-embedding-jobs/repository-index-jobs/
 * repository-clone-jobs/component-generation-jobs/website-scan-jobs. This
 * queue's own jobId is the analysis record's id (repository_issue_analyses.id),
 * distinct from the issue's own id.
 */
const QUEUE_NAME = 'repository-issue-analysis-jobs';

function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface RepositoryIssueAnalysisJobPayload {
  analysisId: string;
  issueId: string;
  repositoryId: string;
  indexJobId: string;
}

interface JobControl {
  controller: AbortController;
  cancelReason: 'user' | null;
}
const jobControls = new Map<string, JobControl>();

let queue: Queue<RepositoryIssueAnalysisJobPayload> | null = null;
function getQueue(): Queue<RepositoryIssueAnalysisJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue<RepositoryIssueAnalysisJobPayload>(QUEUE_NAME, { connection });
  return queue;
}

let workerStarted = false;
export function isRepositoryIssueAnalysisWorkerRunning(): boolean {
  return workerStarted;
}

const TERMINAL_STATUSES: RepositoryIssueAnalysisStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
function isTerminal(status: RepositoryIssueAnalysisStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export async function processJob(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  indexStore: UnifiedRepositoryIndexStore,
  analysisDeps: RunIssueAnalysisDeps,
  payload: RepositoryIssueAnalysisJobPayload,
): Promise<void> {
  const existing = await analysisStore.getByIdAsync(payload.analysisId);
  if (existing && isTerminal(existing.status)) return;

  const controller = new AbortController();
  const control: JobControl = { controller, cancelReason: null };
  jobControls.set(payload.analysisId, control);

  const startedAt = Date.now();

  try {
    await analysisStore.markRunning(payload.analysisId);
    await issueStore.updateStatus(payload.issueId, 'ANALYZING');
    logLifecycle('repository_issue_analysis_started', { repositoryId: payload.repositoryId, issueId: payload.issueId, analysisId: payload.analysisId });

    const issue = await issueStore.getByIdAsync(payload.issueId);
    if (!issue) {
      await analysisStore.complete(payload.analysisId, { status: 'FAILED', error: 'Issue no longer exists.' });
      await issueStore.updateStatus(payload.issueId, 'FAILED');
      return;
    }

    const chunks = await indexStore.getChunksForJobAsync(payload.indexJobId);

    if (control.cancelReason) {
      await analysisStore.complete(payload.analysisId, { status: 'CANCELLED', error: 'Analysis cancelled by user.' });
      await issueStore.updateStatus(payload.issueId, 'OPEN');
      return;
    }

    const result = await runIssueAnalysis(issue, payload.repositoryId, chunks, analysisDeps, control.controller.signal);

    await analysisStore.complete(payload.analysisId, {
      status: 'COMPLETED',
      summary: result.summary,
      rootCause: result.rootCause,
      confidence: result.confidence,
      affectedFiles: result.affectedFiles,
      affectedSymbols: result.affectedSymbols,
      reasoning: result.reasoning,
      recommendedFix: result.recommendedFix,
      validationPlan: result.validationPlan,
      model: result.model,
      evidenceChunkCount: result.evidenceChunkCount,
    });
    await issueStore.updateStatus(payload.issueId, 'ANALYZED');

    logLifecycle('repository_issue_analysis_completed', {
      repositoryId: payload.repositoryId, issueId: payload.issueId, analysisId: payload.analysisId,
      durationMs: Date.now() - startedAt, evidenceChunkCount: result.evidenceChunkCount, confidence: result.confidence,
    });
  } catch (error) {
    const finalStatus = control.cancelReason === 'user' ? 'CANCELLED' : 'FAILED';
    const message = control.cancelReason === 'user'
      ? 'Analysis cancelled by user.'
      : error instanceof IssueAnalysisError
        ? error.message
        : error instanceof Error ? error.message.slice(0, 300) : 'Issue analysis failed.';

    await analysisStore.complete(payload.analysisId, { status: finalStatus, error: message });
    // Never leave the issue stuck on ANALYZING — revert to OPEN so the
    // user can retry, matching every other phase's "revert to previous
    // good state on failure" convention.
    await issueStore.updateStatus(payload.issueId, finalStatus === 'CANCELLED' ? 'OPEN' : 'FAILED');

    logLifecycle(finalStatus === 'CANCELLED' ? 'repository_issue_analysis_cancelled' : 'repository_issue_analysis_failed', {
      repositoryId: payload.repositoryId, issueId: payload.issueId, analysisId: payload.analysisId, durationMs: Date.now() - startedAt,
    });
  } finally {
    jobControls.delete(payload.analysisId);
  }
}

export function enqueueRepositoryIssueAnalysisJob(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  indexStore: UnifiedRepositoryIndexStore,
  analysisDeps: RunIssueAnalysisDeps,
  payload: RepositoryIssueAnalysisJobPayload,
): void {
  logLifecycle('repository_issue_analysis_queued', { repositoryId: payload.repositoryId, issueId: payload.issueId, analysisId: payload.analysisId });
  const q = getQueue();
  if (q) {
    void q.add('repository-issue-analysis', payload, { jobId: payload.analysisId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  setImmediate(() => {
    void processJob(issueStore, analysisStore, indexStore, analysisDeps, payload);
  });
}

export function startRepositoryIssueAnalysisWorker(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  indexStore: UnifiedRepositoryIndexStore,
  analysisDeps: RunIssueAnalysisDeps,
): Worker<RepositoryIssueAnalysisJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<RepositoryIssueAnalysisJobPayload>(
    QUEUE_NAME,
    async (job: Job<RepositoryIssueAnalysisJobPayload>) => {
      await processJob(issueStore, analysisStore, indexStore, analysisDeps, job.data);
    },
    { connection, concurrency: 1, maxStalledCount: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Repository issue analysis job ${job?.id} failed:`, err.message);
  });

  workerStarted = true;
  console.log('Repository issue analysis worker started');
  return worker;
}

/** Same idempotent cancel shape as every other Phase 2/3/4 cancel function. */
export async function cancelRepositoryIssueAnalysisJob(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  analysisId: string,
) {
  const analysis = await analysisStore.getByIdAsync(analysisId);
  if (!analysis) return undefined;
  if (isTerminal(analysis.status)) return analysis;

  const control = jobControls.get(analysisId);
  const wasQueued = !control;

  await analysisStore.complete(analysisId, { status: 'CANCELLED', error: 'Analysis cancelled by user.' });
  await issueStore.updateStatus(analysis.issueId, 'OPEN');

  if (control) {
    control.cancelReason = 'user';
    control.controller.abort();
  } else if (wasQueued) {
    const q = getQueue();
    if (q) {
      try {
        const bullJob = await q.getJob(analysisId);
        if (bullJob) await bullJob.remove();
      } catch {
        // Best-effort — processJob's own terminal-status guard is the remaining safety net.
      }
    }
  }

  return { ...analysis, status: 'CANCELLED' as const };
}
