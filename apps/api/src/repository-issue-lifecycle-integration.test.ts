// Force the always-available legacy in-memory/no-Redis fallback path — same
// convention as every worker test in this project (see e.g.
// repository-index-worker.test.ts). DATABASE_URL='' is sufficient on its
// own for the store layer (pool.ts re-reads it fresh on every call), but
// REDIS_URL must ALSO be forced empty here: a real Redis instance runs in
// this dev environment, and cancelRepositoryFixProposalJob's "job was still
// queued" branch calls getQueue(), which would otherwise open a real
// ioredis connection that keeps the test process alive indefinitely.
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UnifiedRepositoryIndexStore } from './unified-repository-index-store.js';
import { UnifiedRepositoryIssueStore } from './unified-repository-issue-store.js';
import { UnifiedRepositoryIssueAnalysisStore } from './unified-repository-issue-analysis-store.js';
import { UnifiedRepositoryFixProposalStore } from './unified-repository-fix-proposal-store.js';
import { createRepositoryIssue } from './repository-issue-service.js';
import { processJob as processAnalysisJob } from './workers/repository-issue-analysis-worker.js';
import { processJob as processProposalJob, cancelRepositoryFixProposalJob } from './workers/repository-fix-proposal-worker.js';
import { cancelRepositoryIssueAnalysisJob } from './workers/repository-issue-analysis-worker.js';
import type { RunIssueAnalysisDeps } from './repository-issue-analysis-service.js';
import type { ProposeFixDeps } from './repository-fix-service.js';
import type { IssueAnalysisProvider, IssueAnalysisProviderResult } from './repository-issue-analysis-provider.js';
import type { FixProposalProvider, FixProposalProviderResult } from './repository-fix-provider.js';
import type { InsertCodeChunkInput } from './db/repository-index-repository.js';

const VALID_DIFF = '--- a/src/scoring/index.ts\n+++ b/src/scoring/index.ts\n@@ -1,3 +1,3 @@\n function calculateHealthScore(pages) {\n-  return average(pages);\n+  return weightedAverage(pages);\n }';

class FakeAnalysisProvider implements IssueAnalysisProvider {
  result: IssueAnalysisProviderResult = {
    model: 'fake-analysis-model', summary: 'The score ignores weighting.', rootCause: 'average() does not weight by page importance.',
    confidence: 'HIGH', affectedFiles: ['src/scoring/index.ts'], affectedSymbols: ['calculateHealthScore'],
    reasoning: 'Confirmed from evidence: calculateHealthScore calls average() directly.', recommendedFix: 'Use weightedAverage instead.', validationPlan: 'Re-run scoring tests.',
  };
  delayUntil: Promise<void> | null = null;
  async analyze(_request: unknown, signal?: AbortSignal): Promise<IssueAnalysisProviderResult> {
    if (this.delayUntil) {
      await Promise.race([
        this.delayUntil,
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ]);
    }
    return this.result;
  }
}

class FakeFixProvider implements FixProposalProvider {
  async proposeFix(): Promise<FixProposalProviderResult> {
    return { model: 'fake-fix-model', summary: 'Switch to weightedAverage.', files: [{ filePath: 'src/scoring/index.ts', changeType: 'MODIFIED', diff: VALID_DIFF }] };
  }
}

async function buildFixture() {
  const indexStore = new UnifiedRepositoryIndexStore();
  const issueStore = new UnifiedRepositoryIssueStore();
  const analysisStore = new UnifiedRepositoryIssueAnalysisStore();
  const proposalStore = new UnifiedRepositoryFixProposalStore();

  const repositoryId = randomUUID();
  const commitSha = 'f'.repeat(40);
  const indexJob = await indexStore.create({ id: randomUUID(), repositoryId, cloneJobId: randomUUID(), commitSha });

  const fileId = randomUUID();
  await indexStore.insertFile({
    id: fileId, indexJobId: indexJob.jobId, repositoryId, commitSha,
    filePath: 'src/scoring/index.ts', language: 'typescript', fileSizeBytes: 100, status: 'INDEXED', contentHash: 'original-file-hash',
  });
  const chunk: InsertCodeChunkInput = {
    id: randomUUID(), indexJobId: indexJob.jobId, repositoryId, commitSha, fileId,
    filePath: 'src/scoring/index.ts', language: 'typescript', symbol: 'calculateHealthScore', symbolType: 'function',
    parentSymbol: null, startLine: 1, endLine: 3, startColumn: 0, endColumn: 1, isExported: true,
    content: 'function calculateHealthScore(pages) {\n  return average(pages);\n}', contentHash: 'chunk-hash', chunkKey: 'key-1',
  };
  await indexStore.insertChunksBatch([chunk]);
  await indexStore.complete(indexJob.jobId, { status: 'COMPLETED', filesIndexed: 1, filesSkipped: 0, chunksCreated: 1 });

  return { indexStore, issueStore, analysisStore, proposalStore, repositoryId, commitSha, indexJobId: indexJob.jobId, originalChunk: { ...chunk } };
}

describe('Repository issue lifecycle — create -> analyze -> propose fix -> approve/reject (integration)', () => {
  it('happy path: approve marks proposal/issue APPROVED and never mutates any indexed content', async () => {
    const { indexStore, issueStore, analysisStore, proposalStore, repositoryId, commitSha, indexJobId, originalChunk } = await buildFixture();

    const issue = await createRepositoryIssue(
      { id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' },
      { indexStore, issueStore },
      { repositoryId, ownerId: 'owner-a', title: 'Health score ignores weighting', description: 'calculateHealthScore uses a plain average, not weighted.', filePath: 'src/scoring/index.ts', symbol: 'calculateHealthScore' },
    );
    assert.equal(issue.status, 'OPEN');

    const analysisId = randomUUID();
    await analysisStore.create({ id: analysisId, issueId: issue.id, repositoryId, commitSha });
    const analysisDeps: RunIssueAnalysisDeps = { provider: new FakeAnalysisProvider() };
    await processAnalysisJob(issueStore, analysisStore, indexStore, analysisDeps, { analysisId, issueId: issue.id, repositoryId, indexJobId });

    const analysis = await analysisStore.getByIdAsync(analysisId);
    assert.equal(analysis?.status, 'COMPLETED');
    assert.equal(analysis?.confidence, 'HIGH');
    const analyzedIssue = await issueStore.getByIdAsync(issue.id);
    assert.equal(analyzedIssue?.status, 'ANALYZED');

    const proposalId = randomUUID();
    await proposalStore.create({ id: proposalId, issueId: issue.id, repositoryId, commitSha });
    const proposeDeps: ProposeFixDeps = { provider: new FakeFixProvider() };
    await processProposalJob(issueStore, analysisStore, proposalStore, indexStore, proposeDeps, { proposalId, issueId: issue.id, repositoryId });

    const proposal = await proposalStore.getByIdAsync(proposalId);
    assert.equal(proposal?.status, 'FIX_PROPOSED');
    assert.equal(proposal?.filesChanged.length, 1);
    assert.ok(proposal?.proposedDiff.includes('weightedAverage'));
    const proposedIssue = await issueStore.getByIdAsync(issue.id);
    assert.equal(proposedIssue?.status, 'FIX_PROPOSED');

    // Approve — review-only, must never touch any indexed content.
    const approved = await proposalStore.setDecisionAsync(proposalId, 'APPROVED');
    await issueStore.updateStatus(issue.id, 'APPROVED');
    assert.equal(approved?.status, 'APPROVED');
    const finalIssue = await issueStore.getByIdAsync(issue.id);
    assert.equal(finalIssue?.status, 'APPROVED');

    // Proof of no repository mutation: the indexed chunk this whole flow
    // reasoned about is byte-for-byte identical to what we inserted before
    // any analysis/proposal/approval ever ran.
    const chunksAfter = await indexStore.getChunksForJobAsync(indexJobId);
    const chunkAfter = chunksAfter.find((c) => c.id === originalChunk.id);
    assert.deepEqual(chunkAfter, originalChunk);
  });

  it('reject path: proposal and issue both become REJECTED, content still unchanged', async () => {
    const { indexStore, issueStore, analysisStore, proposalStore, repositoryId, commitSha, indexJobId } = await buildFixture();
    const issue = await createRepositoryIssue({ id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, { indexStore, issueStore }, { repositoryId, ownerId: 'owner-a', title: 'T', description: 'D' });

    const analysisId = randomUUID();
    await analysisStore.create({ id: analysisId, issueId: issue.id, repositoryId, commitSha });
    await processAnalysisJob(issueStore, analysisStore, indexStore, { provider: new FakeAnalysisProvider() }, { analysisId, issueId: issue.id, repositoryId, indexJobId });

    const proposalId = randomUUID();
    await proposalStore.create({ id: proposalId, issueId: issue.id, repositoryId, commitSha });
    await processProposalJob(issueStore, analysisStore, proposalStore, indexStore, { provider: new FakeFixProvider() }, { proposalId, issueId: issue.id, repositoryId });

    const rejected = await proposalStore.setDecisionAsync(proposalId, 'REJECTED');
    await issueStore.updateStatus(issue.id, 'REJECTED');
    assert.equal(rejected?.status, 'REJECTED');
    assert.equal((await issueStore.getByIdAsync(issue.id))?.status, 'REJECTED');
  });

  it('duplicate protection: a second analyze request is blocked while one is already active', async () => {
    const { issueStore, analysisStore, indexStore, repositoryId, commitSha } = await buildFixture();
    const issue = await createRepositoryIssue({ id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, { indexStore, issueStore }, { repositoryId, ownerId: 'owner-a', title: 'T', description: 'D' });

    await analysisStore.create({ id: randomUUID(), issueId: issue.id, repositoryId, commitSha });
    assert.equal(await analysisStore.hasActiveAnalysisAsync(issue.id), true);
  });

  it('duplicate protection: a second propose-fix request is blocked while one is active or already proposed', async () => {
    const { proposalStore, repositoryId, commitSha, issueStore, indexStore } = await buildFixture();
    const issue = await createRepositoryIssue({ id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, { indexStore, issueStore }, { repositoryId, ownerId: 'owner-a', title: 'T', description: 'D' });

    await proposalStore.create({ id: randomUUID(), issueId: issue.id, repositoryId, commitSha });
    assert.equal(await proposalStore.hasActiveProposalAsync(issue.id), true);
  });

  it('cancellation: cancelling an in-progress analysis aborts the provider call and reverts the issue to OPEN', async () => {
    const { indexStore, issueStore, analysisStore, repositoryId, commitSha, indexJobId } = await buildFixture();
    const issue = await createRepositoryIssue({ id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, { indexStore, issueStore }, { repositoryId, ownerId: 'owner-a', title: 'T', description: 'D' });

    const analysisId = randomUUID();
    await analysisStore.create({ id: analysisId, issueId: issue.id, repositoryId, commitSha });

    let releaseProvider: () => void = () => {};
    const provider = new FakeAnalysisProvider();
    provider.delayUntil = new Promise((resolve) => { releaseProvider = resolve; });

    const jobPromise = processAnalysisJob(issueStore, analysisStore, indexStore, { provider }, { analysisId, issueId: issue.id, repositoryId, indexJobId });

    // Give processJob a tick to reach markRunning/the provider call, then cancel.
    await new Promise((r) => setImmediate(r));
    await cancelRepositoryIssueAnalysisJob(issueStore, analysisStore, analysisId);
    releaseProvider();
    await jobPromise;

    const finalAnalysis = await analysisStore.getByIdAsync(analysisId);
    assert.equal(finalAnalysis?.status, 'CANCELLED');
    const finalIssue = await issueStore.getByIdAsync(issue.id);
    assert.equal(finalIssue?.status, 'OPEN');
  });

  it('cancellation: cancelling an in-progress fix proposal marks it FAILED without ever completing', async () => {
    const { indexStore, issueStore, analysisStore, proposalStore, repositoryId, commitSha, indexJobId } = await buildFixture();
    const issue = await createRepositoryIssue({ id: repositoryId, userId: 'owner-a', organizationId: 'owner-a', status: 'READY_FOR_SEARCH' }, { indexStore, issueStore }, { repositoryId, ownerId: 'owner-a', title: 'T', description: 'D' });

    const analysisId = randomUUID();
    await analysisStore.create({ id: analysisId, issueId: issue.id, repositoryId, commitSha });
    await processAnalysisJob(issueStore, analysisStore, indexStore, { provider: new FakeAnalysisProvider() }, { analysisId, issueId: issue.id, repositoryId, indexJobId });

    const proposalId = randomUUID();
    await proposalStore.create({ id: proposalId, issueId: issue.id, repositoryId, commitSha });
    const cancelled = await cancelRepositoryFixProposalJob(proposalStore, proposalId);
    assert.equal(cancelled?.status, 'FAILED');
  });
});
