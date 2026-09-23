import '../load-env.js';
import { Queue, Worker, type Job } from 'bullmq';
import type { RepositoryFixProposalStatus } from '@origami/contracts';
import { UnifiedRepositoryIssueStore } from '../unified-repository-issue-store.js';
import { UnifiedRepositoryIssueAnalysisStore } from '../unified-repository-issue-analysis-store.js';
import { UnifiedRepositoryFixProposalStore } from '../unified-repository-fix-proposal-store.js';
import { UnifiedRepositoryIndexStore } from '../unified-repository-index-store.js';
import { proposeFixForIssue, FixProposalError, type ProposeFixDeps } from '../repository-fix-service.js';
import { getRedisConnection } from './website-scan-worker.js';

/** Isolated queue — never repository-issue-analysis-jobs or any Phase 2-6 queue. */
const QUEUE_NAME = 'repository-fix-proposal-jobs';

function logLifecycle(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export interface RepositoryFixProposalJobPayload {
  proposalId: string;
  issueId: string;
  repositoryId: string;
}

interface JobControl {
  controller: AbortController;
  cancelReason: 'user' | null;
}
const jobControls = new Map<string, JobControl>();

let queue: Queue<RepositoryFixProposalJobPayload> | null = null;
function getQueue(): Queue<RepositoryFixProposalJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!queue) queue = new Queue<RepositoryFixProposalJobPayload>(QUEUE_NAME, { connection });
  return queue;
}

let workerStarted = false;
export function isRepositoryFixProposalWorkerRunning(): boolean {
  return workerStarted;
}

const TERMINAL_STATUSES: RepositoryFixProposalStatus[] = ['FIX_PROPOSED', 'APPROVED', 'REJECTED', 'FAILED'];
function isTerminal(status: RepositoryFixProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export async function processJob(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  proposalStore: UnifiedRepositoryFixProposalStore,
  indexStore: UnifiedRepositoryIndexStore,
  proposeDeps: ProposeFixDeps,
  payload: RepositoryFixProposalJobPayload,
): Promise<void> {
  const existing = await proposalStore.getByIdAsync(payload.proposalId);
  if (existing && isTerminal(existing.status)) return;

  const controller = new AbortController();
  const control: JobControl = { controller, cancelReason: null };
  jobControls.set(payload.proposalId, control);

  const startedAt = Date.now();

  try {
    await proposalStore.markRunning(payload.proposalId);
    logLifecycle('repository_fix_proposal_started', { repositoryId: payload.repositoryId, issueId: payload.issueId, proposalId: payload.proposalId });

    const issue = await issueStore.getByIdAsync(payload.issueId);
    const analysis = await analysisStore.getLatestForIssueAsync(payload.issueId);
    if (!issue || !analysis || analysis.status !== 'COMPLETED') {
      await proposalStore.complete(payload.proposalId, { status: 'FAILED', validationError: 'No completed analysis is available for this issue.' });
      return;
    }

    // Fetched FRESH at execution time (never the request-time index job)
    // so a re-index that happened between the propose-fix request and this
    // worker actually running is caught here too, not just at the route —
    // "do not rely only on route-level checks" applies to commit-mismatch
    // the same way it applies to duplicate-job protection.
    const currentIndexJob = await indexStore.getLatestForRepositoryAsync(payload.repositoryId);
    if (!currentIndexJob || currentIndexJob.status !== 'COMPLETED') {
      await proposalStore.complete(payload.proposalId, { status: 'FAILED', validationError: 'No successful repository index is currently available.' });
      return;
    }

    const [indexedFiles, indexedChunks] = await Promise.all([
      indexStore.getFilesForJobAsync(currentIndexJob.jobId),
      indexStore.getChunksForJobAsync(currentIndexJob.jobId),
    ]);

    if (control.cancelReason) {
      await proposalStore.complete(payload.proposalId, { status: 'FAILED', validationError: 'Fix proposal cancelled by user.' });
      return;
    }

    const result = await proposeFixForIssue(
      issue,
      payload.repositoryId,
      currentIndexJob.commitSha,
      {
        model: analysis.model ?? '',
        summary: analysis.summary ?? '',
        rootCause: analysis.rootCause ?? '',
        confidence: analysis.confidence ?? 'LOW',
        affectedFiles: analysis.affectedFiles ?? [],
        affectedSymbols: analysis.affectedSymbols ?? [],
        reasoning: analysis.reasoning ?? '',
        recommendedFix: analysis.recommendedFix ?? '',
        validationPlan: analysis.validationPlan ?? '',
      },
      indexedFiles,
      indexedChunks,
      proposeDeps,
      control.controller.signal,
    );

    await proposalStore.complete(payload.proposalId, {
      status: 'FIX_PROPOSED',
      summary: result.summary,
      filesChanged: result.filesChanged,
      proposedDiff: result.proposedDiff,
      model: result.model,
    });
    await issueStore.updateStatus(payload.issueId, 'FIX_PROPOSED');

    logLifecycle('repository_fix_proposal_completed', {
      repositoryId: payload.repositoryId, issueId: payload.issueId, proposalId: payload.proposalId,
      durationMs: Date.now() - startedAt, filesChanged: result.filesChanged.length,
    });
  } catch (error) {
    const message = control.cancelReason === 'user'
      ? 'Fix proposal cancelled by user.'
      : error instanceof FixProposalError
        ? error.message
        : error instanceof Error ? error.message.slice(0, 300) : 'Fix proposal failed.';

    // A failed/invalid proposal never reverts the issue below FIX_PROPOSED/
    // ANALYZED — it stays ANALYZED (the analysis itself is still valid),
    // ready for another propose-fix attempt.
    await proposalStore.complete(payload.proposalId, { status: 'FAILED', validationError: message });

    logLifecycle('repository_fix_proposal_failed', {
      repositoryId: payload.repositoryId, issueId: payload.issueId, proposalId: payload.proposalId, durationMs: Date.now() - startedAt,
    });
  } finally {
    jobControls.delete(payload.proposalId);
  }
}

export function enqueueRepositoryFixProposalJob(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  proposalStore: UnifiedRepositoryFixProposalStore,
  indexStore: UnifiedRepositoryIndexStore,
  proposeDeps: ProposeFixDeps,
  payload: RepositoryFixProposalJobPayload,
): void {
  logLifecycle('repository_fix_proposal_queued', { repositoryId: payload.repositoryId, issueId: payload.issueId, proposalId: payload.proposalId });
  const q = getQueue();
  if (q) {
    void q.add('repository-fix-proposal', payload, { jobId: payload.proposalId, attempts: 1, removeOnComplete: 100, removeOnFail: 50 });
    return;
  }
  setImmediate(() => {
    void processJob(issueStore, analysisStore, proposalStore, indexStore, proposeDeps, payload);
  });
}

export function startRepositoryFixProposalWorker(
  issueStore: UnifiedRepositoryIssueStore,
  analysisStore: UnifiedRepositoryIssueAnalysisStore,
  proposalStore: UnifiedRepositoryFixProposalStore,
  indexStore: UnifiedRepositoryIndexStore,
  proposeDeps: ProposeFixDeps,
): Worker<RepositoryFixProposalJobPayload> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker<RepositoryFixProposalJobPayload>(
    QUEUE_NAME,
    async (job: Job<RepositoryFixProposalJobPayload>) => {
      await processJob(issueStore, analysisStore, proposalStore, indexStore, proposeDeps, job.data);
    },
    { connection, concurrency: 1, maxStalledCount: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`Repository fix proposal job ${job?.id} failed:`, err.message);
  });

  workerStarted = true;
  console.log('Repository fix proposal worker started');
  return worker;
}

export async function cancelRepositoryFixProposalJob(proposalStore: UnifiedRepositoryFixProposalStore, proposalId: string) {
  const proposal = await proposalStore.getByIdAsync(proposalId);
  if (!proposal) return undefined;
  if (isTerminal(proposal.status)) return proposal;

  const control = jobControls.get(proposalId);
  const wasQueued = !control;

  await proposalStore.complete(proposalId, { status: 'FAILED', validationError: 'Fix proposal cancelled by user.' });

  if (control) {
    control.cancelReason = 'user';
    control.controller.abort();
  } else if (wasQueued) {
    const q = getQueue();
    if (q) {
      try {
        const bullJob = await q.getJob(proposalId);
        if (bullJob) await bullJob.remove();
      } catch {
        // Best-effort — processJob's own terminal-status guard is the remaining safety net.
      }
    }
  }

  return { ...proposal, status: 'FAILED' as const };
}
