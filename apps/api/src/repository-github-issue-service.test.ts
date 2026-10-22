import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubIssueLink, Issue } from '@origami/contracts';
import { RepositoryProviderError, type CreateGitHubIssueParams, type GitHubIssueInfo, type RepositoryProviderClient } from './repository-provider-client.js';
import {
  GitHubIssueError,
  buildGitHubIssueBody,
  buildGitHubIssueLabels,
  buildGitHubIssuePreview,
  createGitHubIssueForFinding,
  type GitHubIssueLinkStore,
} from './repository-github-issue-service.js';

/** In-memory fake of GitHubIssueLinkStore, mirroring ScanStore's real synchronous semantics (see scan-store.ts's linkGitHubIssue doc comment) — tracks every `linkGitHubIssue` call so tests can assert the provider/store were (or weren't) actually invoked. */
function fakeStore(seed: GitHubIssueLink[] = []): GitHubIssueLinkStore & { linked: Array<{ issueId: string; link: GitHubIssueLink }> } {
  const links = [...seed];
  const linked: Array<{ issueId: string; link: GitHubIssueLink }> = [];
  return {
    linked,
    async findGitHubIssueLink(_issueId, repositoryId, provider) {
      return links.find((l) => l.repositoryId === repositoryId && l.provider === provider);
    },
    async linkGitHubIssue(issueId, link) {
      const existing = links.find((l) => l.repositoryId === link.repositoryId && l.provider === link.provider);
      if (existing) return { alreadyExisted: true, link: existing };
      const newLink: GitHubIssueLink = { ...link, createdAt: new Date().toISOString() };
      links.push(newLink);
      linked.push({ issueId, link: newLink });
      return { alreadyExisted: false, link: newLink };
    },
  };
}

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    category: 'accessibility',
    type: 'empty-button',
    severity: 'HIGH',
    title: 'Empty button',
    evidence: { selector: 'button.theme-option.active' },
    confidence: 0.9,
    impact: 'Screen reader users cannot tell what this button does.',
    source: 'axe-core',
    problem: 'The theme selector button does not have an accessible name.',
    cause: 'No aria-label or visible text was provided.',
    suggestedFix: 'Add an aria-label using the theme name.',
    status: 'open',
    scanId: 'scan-1',
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<RepositoryProviderClient> = {}): RepositoryProviderClient {
  return {
    provider: 'GITHUB',
    async validateRemoteAccess() {},
    async getRepositoryInfo() { return { defaultBranch: 'main' }; },
    async createPullRequest() { throw new Error('not used in these tests'); },
    async getPushCredentials() { throw new Error('not used in these tests'); },
    ...overrides,
  };
}

describe('buildGitHubIssueLabels', () => {
  it('derives lowercase, hyphenated labels from category + severity — never invented beyond the finding', () => {
    assert.deepEqual(buildGitHubIssueLabels(fakeIssue({ category: 'accessibility', severity: 'HIGH' })), ['accessibility', 'high']);
    assert.deepEqual(buildGitHubIssueLabels(fakeIssue({ category: 'visualMobile', severity: 'CRITICAL' })), ['visual-mobile', 'critical']);
  });
});

describe('buildGitHubIssueBody', () => {
  it('includes every section the roadmap example shows, grounded in the finding\'s own fields', () => {
    const body = buildGitHubIssueBody(fakeIssue(), 'https://example.com/settings', 68);
    assert.match(body, /## Problem\n\nThe theme selector button does not have an accessible name\./);
    assert.match(body, /## Page\n\nhttps:\/\/example\.com\/settings/);
    assert.match(body, /## Severity\n\nHIGH/);
    assert.match(body, /## Category\n\nAccessibility/i);
    assert.match(body, /## Selector\n\n`button\.theme-option\.active`/);
    assert.match(body, /## Suggested Fix\n\nAdd an aria-label using the theme name\./);
    assert.match(body, /## Origami Lens/);
    assert.match(body, /Scan: scan-1/);
    assert.match(body, /Issue: issue-1/);
    assert.match(body, /Health Score: 68\/100/);
  });

  it('omits the Health Score line when the scan never completed successfully', () => {
    const body = buildGitHubIssueBody(fakeIssue(), 'https://example.com', null);
    assert.ok(!body.includes('Health Score'));
  });

  it('includes an Evidence section only when the finding actually carries a message/snippet', () => {
    const withEvidence = buildGitHubIssueBody(fakeIssue({ evidence: { selector: 'a', message: 'console error: X is not defined' } }), 'https://example.com', null);
    assert.match(withEvidence, /## Evidence\n\nconsole error: X is not defined/);
    const withoutEvidence = buildGitHubIssueBody(fakeIssue({ evidence: {} }), 'https://example.com', null);
    assert.ok(!withoutEvidence.includes('## Evidence'));
  });
});

describe('buildGitHubIssuePreview', () => {
  it('resolves owner/repo from the repository URL and reuses the same body/label builders', () => {
    const preview = buildGitHubIssuePreview({ repoUrl: 'https://github.com/octocat/Hello-World' }, fakeIssue(), 'https://example.com', 68);
    assert.equal(preview.owner, 'octocat');
    assert.equal(preview.repo, 'Hello-World');
    assert.equal(preview.title, 'Empty button');
    assert.deepEqual(preview.labels, ['accessibility', 'high']);
    assert.match(preview.body, /## Origami Lens/);
  });

  it('throws GitHubIssueError REPOSITORY_NOT_FOUND for an unparsable repository URL', () => {
    assert.throws(
      () => buildGitHubIssuePreview({ repoUrl: 'not a url' }, fakeIssue(), 'https://example.com', null),
      (error: unknown) => { assert.ok(error instanceof GitHubIssueError); assert.equal(error.code, 'REPOSITORY_NOT_FOUND'); return true; },
    );
  });
});

describe('createGitHubIssueForFinding', () => {
  it('rejects when the repository does not belong to the caller\'s organization (never confirms existence to a caller it doesn\'t belong to)', async () => {
    let called = false;
    const provider = fakeProvider({ createIssue: async () => { called = true; return { number: 1, url: 'x' }; } });
    await assert.rejects(
      () => createGitHubIssueForFinding('user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World' }, 'org-b', fakeIssue(), 'https://example.com', null, {}, { provider, store: fakeStore() }),
      (error: unknown) => { assert.ok(error instanceof GitHubIssueError); assert.equal(error.code, 'REPOSITORY_ACCESS_DENIED'); return true; },
    );
    assert.equal(called, false);
  });

  it('rejects with REPOSITORY_NOT_FOUND when no repository was resolved', async () => {
    const provider = fakeProvider({ createIssue: async () => ({ number: 1, url: 'x' }) });
    await assert.rejects(
      () => createGitHubIssueForFinding('user-1', undefined, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store: fakeStore() }),
      (error: unknown) => { assert.ok(error instanceof GitHubIssueError); assert.equal(error.code, 'REPOSITORY_NOT_FOUND'); return true; },
    );
  });

  it('rejects with PROVIDER_UNSUPPORTED when the resolved provider client has no createIssue implementation (e.g. GitLab/Bitbucket today)', async () => {
    const provider = fakeProvider({ createIssue: undefined });
    await assert.rejects(
      () => createGitHubIssueForFinding('user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://gitlab.com/x/y', provider: 'GITLAB' }, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store: fakeStore() }),
      (error: unknown) => { assert.ok(error instanceof GitHubIssueError); assert.equal(error.code, 'PROVIDER_UNSUPPORTED'); return true; },
    );
  });

  it('creates the issue with the generated title/body/labels when the caller supplies no overrides', async () => {
    let captured: CreateGitHubIssueParams | undefined;
    const provider = fakeProvider({
      createIssue: async (_userId, params): Promise<GitHubIssueInfo> => { captured = params; return { number: 42, url: 'https://github.com/octocat/Hello-World/issues/42' }; },
    });

    const result = await createGitHubIssueForFinding(
      'user-1',
      { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World' },
      'org-a',
      fakeIssue(),
      'https://example.com/settings',
      68,
      {},
      { provider, store: fakeStore() },
    );

    assert.equal(result.issueNumber, 42);
    assert.equal(result.issueUrl, 'https://github.com/octocat/Hello-World/issues/42');
    assert.equal(captured!.owner, 'octocat');
    assert.equal(captured!.repo, 'Hello-World');
    assert.equal(captured!.title, 'Empty button');
    assert.deepEqual(captured!.labels, ['accessibility', 'high']);
    assert.match(captured!.body, /## Origami Lens/);
  });

  it('honors caller-supplied title/body/labels overrides (the reviewed/edited confirmation-dialog content) over the generated defaults', async () => {
    let captured: CreateGitHubIssueParams | undefined;
    const provider = fakeProvider({
      createIssue: async (_userId, params): Promise<GitHubIssueInfo> => { captured = params; return { number: 1, url: 'x' }; },
    });

    await createGitHubIssueForFinding(
      'user-1',
      { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World' },
      'org-a',
      fakeIssue(),
      'https://example.com',
      null,
      { title: 'Edited title', body: 'Edited body', labels: ['custom-label'] },
      { provider, store: fakeStore() },
    );

    assert.equal(captured!.title, 'Edited title');
    assert.equal(captured!.body, 'Edited body');
    assert.deepEqual(captured!.labels, ['custom-label']);
  });

  it('maps a RepositoryProviderError from the provider onto the matching GitHubIssueError code — a 403/RATE_LIMITED becomes GITHUB_PERMISSION_DENIED', async () => {
    const provider = fakeProvider({
      createIssue: async () => { throw new RepositoryProviderError('Resource not accessible by integration', 'RATE_LIMITED'); },
    });
    await assert.rejects(
      () => createGitHubIssueForFinding('user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World' }, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store: fakeStore() }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubIssueError);
        assert.equal(error.code, 'GITHUB_PERMISSION_DENIED');
        assert.match(error.message, /permission to create issues/i);
        return true;
      },
    );
  });

  it('maps AUTH_NOT_CONFIGURED/AUTH_FAILED to GITHUB_AUTH_NOT_CONFIGURED', async () => {
    const provider = fakeProvider({
      createIssue: async () => { throw new RepositoryProviderError('No GitHub connection for this user/repository.', 'AUTH_NOT_CONFIGURED'); },
    });
    await assert.rejects(
      () => createGitHubIssueForFinding('user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World' }, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store: fakeStore() }),
      (error: unknown) => { assert.ok(error instanceof GitHubIssueError); assert.equal(error.code, 'GITHUB_AUTH_NOT_CONFIGURED'); return true; },
    );
  });

  it('bugfix (duplicate GitHub issues): creates the issue and PERSISTS the link via the store', async () => {
    const provider = fakeProvider({
      createIssue: async (): Promise<GitHubIssueInfo> => ({ number: 42, url: 'https://github.com/octocat/Hello-World/issues/42' }),
    });
    const store = fakeStore();

    const result = await createGitHubIssueForFinding(
      'user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB' }, 'org-a',
      fakeIssue(), 'https://example.com', null, {}, { provider, store },
    );

    assert.equal(result.issueNumber, 42);
    assert.equal(result.alreadyExisted, false);
    assert.equal(store.linked.length, 1);
    assert.equal(store.linked[0].issueId, 'issue-1');
    assert.equal(store.linked[0].link.repositoryId, 'repo-1');
    assert.equal(store.linked[0].link.issueNumber, 42);
  });

  it('bugfix (duplicate GitHub issues): a finding whose githubIssueLinks ALREADY has this repository+provider returns the existing link and never calls the provider or the store again', async () => {
    let providerCalled = false;
    const provider = fakeProvider({ createIssue: async () => { providerCalled = true; return { number: 999, url: 'should-never-be-used' }; } });
    const store = fakeStore();

    const issue = fakeIssue({
      githubIssueLinks: [{ repositoryId: 'repo-1', provider: 'GITHUB', githubOwner: 'octocat', githubRepository: 'Hello-World', issueNumber: 7, issueUrl: 'https://github.com/octocat/Hello-World/issues/7', createdAt: new Date().toISOString() }],
    });

    const result = await createGitHubIssueForFinding(
      'user-1', { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB' }, 'org-a',
      issue, 'https://example.com', null, {}, { provider, store },
    );

    assert.equal(result.issueNumber, 7);
    assert.equal(result.issueUrl, 'https://github.com/octocat/Hello-World/issues/7');
    assert.equal(result.alreadyExisted, true);
    assert.equal(providerCalled, false);
    assert.equal(store.linked.length, 0);
  });

  it('bugfix (duplicate GitHub issues): a REPEATED call after a first successful create also returns the existing link without calling the provider again', async () => {
    let providerCalls = 0;
    const provider = fakeProvider({
      createIssue: async (): Promise<GitHubIssueInfo> => { providerCalls += 1; return { number: 42, url: 'https://github.com/octocat/Hello-World/issues/42' }; },
    });
    const store = fakeStore();
    const repository = { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB' };

    const first = await createGitHubIssueForFinding('user-1', repository, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store });
    // Simulates the route reloading the issue fresh from the store before a second call (exactly what happens on a page reload / second click) — githubIssueLinks now reflects the first call's persisted write.
    const reloadedIssue = fakeIssue({ githubIssueLinks: [{ repositoryId: 'repo-1', provider: 'GITHUB', githubOwner: 'octocat', githubRepository: 'Hello-World', issueNumber: first.issueNumber, issueUrl: first.issueUrl, createdAt: new Date().toISOString() }] });
    const second = await createGitHubIssueForFinding('user-1', repository, 'org-a', reloadedIssue, 'https://example.com', null, {}, { provider, store });
    const third = await createGitHubIssueForFinding('user-1', repository, 'org-a', reloadedIssue, 'https://example.com', null, {}, { provider, store });

    assert.equal(providerCalls, 1);
    assert.equal(second.issueNumber, 42);
    assert.equal(second.alreadyExisted, true);
    assert.equal(third.issueNumber, 42);
    assert.equal(store.linked.length, 1);
  });

  it('bugfix (duplicate GitHub issues): TWO SIMULTANEOUS requests for the same finding+repository only ever call the provider ONCE and both resolve to the SAME issue', async () => {
    let providerCalls = 0;
    const provider = fakeProvider({
      createIssue: async (): Promise<GitHubIssueInfo> => {
        providerCalls += 1;
        // A real network call takes real time — yielding here lets both
        // concurrent calls actually race past the "is anything in flight"
        // check before either resolves, the exact race this test targets.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { number: 42, url: 'https://github.com/octocat/Hello-World/issues/42' };
      },
    });
    const store = fakeStore();
    const repository = { id: 'repo-1', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/Hello-World', provider: 'GITHUB' };

    const [a, b] = await Promise.all([
      createGitHubIssueForFinding('user-1', repository, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store }),
      createGitHubIssueForFinding('user-1', repository, 'org-a', fakeIssue(), 'https://example.com', null, {}, { provider, store }),
    ]);

    assert.equal(providerCalls, 1, 'GitHub must only ever be called once for two simultaneous requests');
    assert.equal(a.issueNumber, 42);
    assert.equal(b.issueNumber, 42);
    assert.equal(a.issueUrl, b.issueUrl);
    assert.equal(store.linked.length, 1, 'only one link may ever be persisted for the same finding+repository');
  });

  it('bugfix (duplicate GitHub issues): a DIFFERENT repository for the SAME finding is a separate, valid relationship and is NOT blocked by an existing link in another repository', async () => {
    const provider = fakeProvider({
      createIssue: async (_userId, params): Promise<GitHubIssueInfo> => ({ number: 20, url: `https://github.com/${params.owner}/${params.repo}/issues/20` }),
    });
    const store = fakeStore();
    const issue = fakeIssue({
      githubIssueLinks: [{ repositoryId: 'repo-A', provider: 'GITHUB', githubOwner: 'octocat', githubRepository: 'repo-a', issueNumber: 50, issueUrl: 'https://github.com/octocat/repo-a/issues/50', createdAt: new Date().toISOString() }],
    });

    const result = await createGitHubIssueForFinding(
      'user-1', { id: 'repo-B', organizationId: 'org-a', repoUrl: 'https://github.com/octocat/repo-b', provider: 'GITHUB' }, 'org-a',
      issue, 'https://example.com', null, {}, { provider, store },
    );

    assert.equal(result.issueNumber, 20);
    assert.equal(result.alreadyExisted, false);
    assert.equal(store.linked.length, 1);
    assert.equal(store.linked[0].link.repositoryId, 'repo-B');
  });
});
