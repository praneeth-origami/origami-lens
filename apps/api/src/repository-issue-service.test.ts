import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IssueError, createRepositoryIssue, getRepositoryIssue, listRepositoryIssues, type IssueStores } from './repository-issue-service.js';
import type { RepositoryIssue } from '@origami/contracts';
import type { InsertCodeChunkInput, InsertIndexFileInput } from './db/repository-index-repository.js';

const INDEX_JOB_ID = randomUUID();
const COMMIT_SHA = 'a'.repeat(40);

const SAMPLE_FILE: InsertIndexFileInput = {
  id: randomUUID(), indexJobId: INDEX_JOB_ID, repositoryId: 'repo-1', commitSha: COMMIT_SHA,
  filePath: 'src/auth/login.ts', language: 'typescript', fileSizeBytes: 100, contentHash: 'hash-1', status: 'INDEXED',
};

const SAMPLE_CHUNK: InsertCodeChunkInput = {
  id: randomUUID(), indexJobId: INDEX_JOB_ID, repositoryId: 'repo-1', commitSha: COMMIT_SHA, fileId: SAMPLE_FILE.id,
  filePath: 'src/auth/login.ts', language: 'typescript', symbol: 'authenticateUser', symbolType: 'function',
  parentSymbol: null, startLine: 1, endLine: 5, startColumn: 0, endColumn: 1, isExported: true,
  content: 'function authenticateUser() {}', contentHash: 'chunk-hash-1', chunkKey: 'key-1',
};

function fakeStores(overrides: { files?: InsertIndexFileInput[]; chunks?: InsertCodeChunkInput[]; issues?: RepositoryIssue[] } = {}): IssueStores {
  const files = overrides.files ?? [SAMPLE_FILE];
  const chunks = overrides.chunks ?? [SAMPLE_CHUNK];
  const issues = new Map<string, RepositoryIssue>();
  for (const issue of overrides.issues ?? []) issues.set(issue.id, issue);

  return {
    indexStore: {
      getLatestForRepositoryAsync: async () => ({
        jobId: INDEX_JOB_ID, repositoryId: 'repo-1', cloneJobId: randomUUID(), commitSha: COMMIT_SHA,
        status: 'COMPLETED', indexerVersion: '1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      getFilesForJobAsync: async () => files,
      getChunksForJobAsync: async () => chunks,
    } as unknown as IssueStores['indexStore'],
    issueStore: {
      create: async (input) => {
        const now = new Date().toISOString();
        const issue: RepositoryIssue = {
          id: input.id, repositoryId: input.repositoryId, ownerId: input.ownerId, commitSha: input.commitSha,
          title: input.title, description: input.description, severity: input.severity, status: 'OPEN', source: input.source,
          filePath: input.filePath, symbol: input.symbol, lineStart: input.lineStart, lineEnd: input.lineEnd,
          createdAt: now, updatedAt: now,
        };
        issues.set(issue.id, issue);
        return issue;
      },
      getByIdAsync: async (id) => issues.get(id),
      listForRepositoryAsync: async (repositoryId) => Array.from(issues.values()).filter((i) => i.repositoryId === repositoryId),
    } as unknown as IssueStores['issueStore'],
  };
}

describe('createRepositoryIssue', () => {
  it('creates an issue with the repository current indexed commit, never a client-supplied one', async () => {
    const stores = fakeStores();
    const issue = await createRepositoryIssue(
      { id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' },
      stores,
      { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'Bug', description: 'Something is wrong' },
    );
    assert.equal(issue.commitSha, COMMIT_SHA);
    assert.equal(issue.status, 'OPEN');
    assert.equal(issue.source, 'USER_REPORTED');
    assert.equal(issue.severity, 'MEDIUM');
  });

  it('accepts a valid filePath and symbol that exist in the index', async () => {
    const stores = fakeStores();
    const issue = await createRepositoryIssue(
      { id: 'repo-1', userId: 'owner-a', status: 'READY_FOR_SEARCH' },
      stores,
      { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'Bug', description: 'D', filePath: 'src/auth/login.ts', symbol: 'authenticateUser', lineStart: 1, lineEnd: 5 },
    );
    assert.equal(issue.filePath, 'src/auth/login.ts');
    assert.equal(issue.symbol, 'authenticateUser');
  });

  it('rejects a missing repository', async () => {
    await assert.rejects(
      () => createRepositoryIssue(undefined, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D' }),
      (e: unknown) => e instanceof IssueError && e.code === 'REPOSITORY_NOT_FOUND',
    );
  });

  it('rejects a wrong-owner request with the same generic error as not-found', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-b', title: 'T', description: 'D' }),
      (e: unknown) => e instanceof IssueError && e.code === 'REPOSITORY_ACCESS_DENIED',
    );
  });

  it('rejects a repository that has never been indexed', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'CONNECTED' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D' }),
      (e: unknown) => e instanceof IssueError && e.code === 'REPOSITORY_NOT_READY',
    );
  });

  it('rejects an empty title', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: '   ', description: 'D' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects an empty description', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: '' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects an invalid severity', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', severity: 'EXTREME' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects a filePath that does not exist in the indexed commit', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', filePath: 'src/does-not-exist.ts' }),
      (e: unknown) => e instanceof IssueError && e.code === 'FILE_NOT_FOUND',
    );
  });

  it('rejects a symbol that does not exist in the indexed commit', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', symbol: 'doesNotExist' }),
      (e: unknown) => e instanceof IssueError && e.code === 'SYMBOL_NOT_FOUND',
    );
  });

  it('rejects an absolute filePath', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', filePath: '/etc/passwd' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects a filePath containing ../ traversal', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', filePath: '../../etc/passwd' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects a sensitive filePath even if somehow present in the index', async () => {
    const stores = fakeStores({ files: [{ ...SAMPLE_FILE, filePath: '.env' }] });
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', filePath: '.env' }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects lineStart without lineEnd', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', lineStart: 5 }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });

  it('rejects lineEnd before lineStart', async () => {
    await assert.rejects(
      () => createRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, fakeStores(), { repositoryId: 'repo-1', ownerId: 'owner-a', title: 'T', description: 'D', lineStart: 10, lineEnd: 5 }),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_VALIDATION_FAILED',
    );
  });
});

describe('getRepositoryIssue / listRepositoryIssues', () => {
  it('returns an issue that belongs to the repository', async () => {
    const issue: RepositoryIssue = {
      id: 'issue-1', repositoryId: 'repo-1', commitSha: COMMIT_SHA, title: 'T', description: 'D',
      severity: 'MEDIUM', status: 'OPEN', source: 'USER_REPORTED', createdAt: 'x', updatedAt: 'x',
    };
    const stores = fakeStores({ issues: [issue] });
    const result = await getRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, 'issue-1', 'owner-a');
    assert.equal(result.id, 'issue-1');
  });

  it('throws ISSUE_NOT_FOUND for an issue belonging to a different repository', async () => {
    const issue: RepositoryIssue = {
      id: 'issue-1', repositoryId: 'repo-OTHER', commitSha: COMMIT_SHA, title: 'T', description: 'D',
      severity: 'MEDIUM', status: 'OPEN', source: 'USER_REPORTED', createdAt: 'x', updatedAt: 'x',
    };
    const stores = fakeStores({ issues: [issue] });
    await assert.rejects(
      () => getRepositoryIssue({ id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' }, stores, 'issue-1', 'owner-a'),
      (e: unknown) => e instanceof IssueError && e.code === 'ISSUE_NOT_FOUND',
    );
  });

  it('owner isolation: a wrong-owner caller cannot list or read another owner\'s issues', async () => {
    const issue: RepositoryIssue = {
      id: 'issue-1', repositoryId: 'repo-1', ownerId: 'owner-a', commitSha: COMMIT_SHA, title: 'T', description: 'D',
      severity: 'MEDIUM', status: 'OPEN', source: 'USER_REPORTED', createdAt: 'x', updatedAt: 'x',
    };
    const stores = fakeStores({ issues: [issue] });
    const repo = { id: 'repo-1', userId: 'owner-a', status: 'EMBEDDINGS_READY' };

    await assert.rejects(
      () => getRepositoryIssue(repo, stores, 'issue-1', 'owner-b'),
      (e: unknown) => e instanceof IssueError && e.code === 'REPOSITORY_NOT_FOUND',
    );
    await assert.rejects(
      () => listRepositoryIssues(repo, stores, 'owner-b'),
      (e: unknown) => e instanceof IssueError && e.code === 'REPOSITORY_NOT_FOUND',
    );

    // The rightful owner can still access it.
    const ok = await getRepositoryIssue(repo, stores, 'issue-1', 'owner-a');
    assert.equal(ok.id, 'issue-1');
  });
});
