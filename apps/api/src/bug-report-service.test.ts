import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BugReport, CreateBugReportRequest } from '@origami/contracts';
import {
  BugReportError,
  createBugReport,
  createGitHubIssueFromBugReport,
  getBugReport,
  type BugReportStores,
  type CreateBugReportGitHubIssueDeps,
} from './bug-report-service.js';
import { GitHubIssueError } from './repository-github-issue-service.js';
import { RepositoryProviderError } from './repository-provider-client.js';
import type { CreateBugReportRow } from './db/bug-report-repository.js';

function fakeRequest(overrides: Partial<CreateBugReportRequest> = {}): CreateBugReportRequest {
  return {
    title: 'Checkout button throws',
    url: 'https://example.com/checkout',
    pageTitle: 'Checkout',
    browser: 'Chrome 129',
    operatingSystem: 'Windows 11',
    viewportWidth: 1440,
    viewportHeight: 900,
    devicePixelRatio: 2,
    consoleErrors: [],
    networkErrors: [],
    description: 'Clicking Checkout throws an exception.',
    severity: 'HIGH',
    category: 'functional',
    reproductionSteps: [],
    ...overrides,
  };
}

function fakeStores(overrides: { created?: CreateBugReportRow[]; savedImages?: Array<{ id: string; key: string; base64: string }>; existing?: BugReport } = {}): BugReportStores {
  const created: CreateBugReportRow[] = overrides.created ?? [];
  const savedImages = overrides.savedImages ?? [];
  return {
    repo: {
      create: async (input) => {
        created.push(input);
        const report: BugReport = {
          id: input.id,
          title: input.title,
          url: input.url,
          pageTitle: input.pageTitle,
          browser: input.browser,
          operatingSystem: input.operatingSystem,
          viewportWidth: input.viewportWidth,
          viewportHeight: input.viewportHeight,
          devicePixelRatio: input.devicePixelRatio,
          hasScreenshot: input.hasScreenshot,
          consoleErrors: input.consoleErrors,
          networkErrors: input.networkErrors,
          domEvidence: input.domEvidence,
          description: input.description,
          severity: input.severity,
          category: input.category,
          reproductionSteps: input.reproductionSteps,
          expectedBehavior: input.expectedBehavior,
          actualBehavior: input.actualBehavior,
          suggestedFix: input.suggestedFix,
          linkedIssueId: input.linkedIssueId,
          linkedScanId: input.linkedScanId,
          createdAt: new Date().toISOString(),
        };
        return report;
      },
      getByIdForOrganizationsAsync: async (id) => overrides.existing?.id === id ? overrides.existing : undefined,
    },
    artifactStore: {
      saveImage: (id, key, base64) => { savedImages.push({ id, key, base64 }); },
    },
  };
}

describe('createBugReport', () => {
  it('rejects a missing title before ever touching the repository', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => createBugReport(fakeRequest({ title: '' }), 'org-1', 'user-1', stores, 'http://localhost:5173'),
      (error: unknown) => { assert.ok(error instanceof BugReportError); assert.equal(error.code, 'BUG_REPORT_INVALID'); return true; },
    );
  });

  it('rejects a missing description', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => createBugReport(fakeRequest({ description: '  ' }), 'org-1', 'user-1', stores, 'http://localhost:5173'),
      (error: unknown) => error instanceof BugReportError && error.code === 'BUG_REPORT_INVALID',
    );
  });

  it('rejects an invalid severity/category', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => createBugReport(fakeRequest({ severity: 'ULTRA' as never }), 'org-1', 'user-1', stores, 'http://localhost:5173'),
      (error: unknown) => error instanceof BugReportError && error.code === 'BUG_REPORT_INVALID',
    );
  });

  it('creates a report and returns a real web app URL', async () => {
    const stores = fakeStores();
    const result = await createBugReport(fakeRequest(), 'org-1', 'user-1', stores, 'http://localhost:5173');
    assert.ok(result.id);
    assert.equal(result.url, `http://localhost:5173/bug-reports/${result.id}`);
  });

  it('scrubs sensitive key=value pairs out of every free-text field (description, console messages, network URLs) before persisting', async () => {
    const created: CreateBugReportRow[] = [];
    const stores = fakeStores({ created });
    await createBugReport(
      fakeRequest({
        description: 'Failed with password=hunter2 in the request.',
        consoleErrors: [{ type: 'error', message: 'token=abc123secret', timestamp: Date.now() }],
        networkErrors: [{ url: 'https://example.com/api?token=xyz789', method: 'GET', status: 500, duration: 10, resourceType: 'fetch', failed: true }],
      }),
      'org-1', 'user-1', stores, 'http://localhost:5173',
    );
    const row = created[0]!;
    assert.ok(!row.description.includes('hunter2'));
    assert.ok(!row.consoleErrors[0]!.message.includes('abc123secret'));
    assert.ok(!row.networkErrors[0]!.url.includes('xyz789'));
  });

  it('saves the screenshot via the artifact store and sets hasScreenshot, keyed by the new report id', async () => {
    const savedImages: Array<{ id: string; key: string; base64: string }> = [];
    const stores = fakeStores({ savedImages });
    const result = await createBugReport(fakeRequest({ screenshotBase64: 'ZmFrZS1qcGVn' }), 'org-1', 'user-1', stores, 'http://localhost:5173');
    assert.equal(savedImages.length, 1);
    assert.equal(savedImages[0]!.id, result.id);
    assert.equal(savedImages[0]!.key, 'screenshot.jpg');
  });

  it('never saves a screenshot when none was captured', async () => {
    const savedImages: Array<{ id: string; key: string; base64: string }> = [];
    const stores = fakeStores({ savedImages });
    await createBugReport(fakeRequest(), 'org-1', 'user-1', stores, 'http://localhost:5173');
    assert.equal(savedImages.length, 0);
  });

  it('when linkedIssue is given, uses its REAL category/severity/suggestedFix — never the client-supplied category/severity', async () => {
    const created: CreateBugReportRow[] = [];
    const stores = fakeStores({ created });
    await createBugReport(
      fakeRequest({ category: 'seo', severity: 'LOW' }),
      'org-1', 'user-1', stores, 'http://localhost:5173',
      { suggestedFix: 'Add a null check before accessing .total', category: 'accessibility', severity: 'CRITICAL' },
    );
    const row = created[0]!;
    assert.equal(row.category, 'accessibility');
    assert.equal(row.severity, 'CRITICAL');
    assert.equal(row.suggestedFix, 'Add a null check before accessing .total');
  });

  it('bounds console errors, network errors, and reproduction steps to at most 20 each', async () => {
    const created: CreateBugReportRow[] = [];
    const stores = fakeStores({ created });
    await createBugReport(
      fakeRequest({
        consoleErrors: Array.from({ length: 30 }, (_, i) => ({ type: 'error' as const, message: `err ${i}`, timestamp: i })),
        networkErrors: Array.from({ length: 30 }, (_, i) => ({ url: `https://x/${i}`, method: 'GET', status: 500, duration: 1, resourceType: 'fetch', failed: true })),
        reproductionSteps: Array.from({ length: 30 }, (_, i) => `step ${i}`),
      }),
      'org-1', 'user-1', stores, 'http://localhost:5173',
    );
    const row = created[0]!;
    assert.equal(row.consoleErrors.length, 20);
    assert.equal(row.networkErrors.length, 20);
    assert.equal(row.reproductionSteps.length, 20);
  });
});

describe('getBugReport', () => {
  it('throws BUG_REPORT_NOT_FOUND for an id the caller cannot access (never confirms existence)', async () => {
    const stores = fakeStores();
    await assert.rejects(
      () => getBugReport('missing-id', ['org-1'], stores.repo),
      (error: unknown) => error instanceof BugReportError && error.code === 'BUG_REPORT_NOT_FOUND',
    );
  });

  it('returns the report when it exists and the caller owns it', async () => {
    const existing: BugReport = {
      id: 'report-1', title: 'T', url: 'https://x', browser: 'Chrome 1', operatingSystem: 'Windows',
      viewportWidth: 100, viewportHeight: 100, devicePixelRatio: 1, hasScreenshot: false,
      consoleErrors: [], networkErrors: [], description: 'd', severity: 'LOW', category: 'functional',
      reproductionSteps: [], createdAt: new Date().toISOString(),
    };
    const stores = fakeStores({ existing });
    const result = await getBugReport('report-1', ['org-1'], stores.repo);
    assert.equal(result.id, 'report-1');
  });
});

describe('createGitHubIssueFromBugReport', () => {
  function fakeReport(overrides: Partial<BugReport> = {}): BugReport {
    return {
      id: 'report-1', title: 'Checkout button throws', url: 'https://example.com/checkout',
      browser: 'Chrome 129', operatingSystem: 'Windows 11', viewportWidth: 1440, viewportHeight: 900, devicePixelRatio: 2,
      hasScreenshot: true, consoleErrors: [{ type: 'error', message: 'boom', timestamp: 1 }],
      networkErrors: [{ url: 'https://example.com/api', method: 'GET', status: 500, duration: 1, resourceType: 'fetch', failed: true }],
      description: 'Clicking Checkout throws.', severity: 'HIGH', category: 'functional',
      reproductionSteps: ['Open /checkout', 'Click Checkout'], suggestedFix: 'Add a null check.',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Tracks linkGitHubIssue calls so tests can assert the link was (or wasn't) persisted. */
  function fakeRepoDep(linked: Array<{ id: string; repositoryId: string; issueNumber: number; issueUrl: string }> = []) {
    return {
      create: async () => { throw new Error('not used in these tests'); },
      getByIdForOrganizationsAsync: async () => undefined,
      linkGitHubIssue: async (id: string, link: { repositoryId: string; issueNumber: number; issueUrl: string }) => {
        linked.push({ id, ...link });
      },
    };
  }

  it('REPOSITORY_NOT_FOUND when the repository is undefined', async () => {
    await assert.rejects(
      () => createGitHubIssueFromBugReport('user-1', undefined, 'org-1', fakeReport(), { provider: {} as never, repo: fakeRepoDep() }),
      (error: unknown) => error instanceof GitHubIssueError && error.code === 'REPOSITORY_NOT_FOUND',
    );
  });

  it('REPOSITORY_ACCESS_DENIED when the repository belongs to a different organization', async () => {
    await assert.rejects(
      () => createGitHubIssueFromBugReport(
        'user-1',
        { id: 'repo-1', organizationId: 'org-2', repoUrl: 'https://github.com/acme/widgets' },
        'org-1',
        fakeReport(),
        { provider: { createIssue: async () => ({ number: 1, url: 'x' }) } as never, repo: fakeRepoDep() },
      ),
      (error: unknown) => error instanceof GitHubIssueError && error.code === 'REPOSITORY_ACCESS_DENIED',
    );
  });

  it('PROVIDER_UNSUPPORTED when the provider has no createIssue method', async () => {
    await assert.rejects(
      () => createGitHubIssueFromBugReport(
        'user-1',
        { id: 'repo-1', organizationId: 'org-1', repoUrl: 'https://gitlab.com/acme/widgets', provider: 'GITLAB' },
        'org-1',
        fakeReport(),
        { provider: {} as never, repo: fakeRepoDep() },
      ),
      (error: unknown) => error instanceof GitHubIssueError && error.code === 'PROVIDER_UNSUPPORTED',
    );
  });

  it('builds a concise, developer-friendly issue body from the bug report\'s own fields, calls the real provider, and PERSISTS the link (bugfix: duplicate GitHub issues)', async () => {
    let capturedParams: { owner: string; repo: string; title: string; body: string; labels: string[] } | null = null;
    const linked: Array<{ id: string; repositoryId: string; issueNumber: number; issueUrl: string }> = [];
    const deps: CreateBugReportGitHubIssueDeps = {
      provider: {
        createIssue: async (_userId, params) => {
          capturedParams = params;
          return { number: 42, url: 'https://github.com/acme/widgets/issues/42' };
        },
      } as never,
      repo: fakeRepoDep(linked),
    };
    const result = await createGitHubIssueFromBugReport(
      'user-1',
      { id: 'repo-1', organizationId: 'org-1', repoUrl: 'https://github.com/acme/widgets' },
      'org-1',
      fakeReport(),
      deps,
    );
    assert.equal(result.issueNumber, 42);
    assert.equal(result.issueUrl, 'https://github.com/acme/widgets/issues/42');
    assert.ok(capturedParams);
    assert.equal(capturedParams!.owner, 'acme');
    assert.equal(capturedParams!.repo, 'widgets');
    assert.equal(capturedParams!.title, 'Checkout button throws');
    assert.match(capturedParams!.body, /Clicking Checkout throws/);
    assert.match(capturedParams!.body, /Open \/checkout/);
    assert.match(capturedParams!.body, /Add a null check/);
    assert.ok(capturedParams!.labels.includes('bug-report'));
    assert.ok(capturedParams!.labels.includes('high'));

    assert.equal(linked.length, 1, 'the created issue must be persisted so a later call never creates a duplicate');
    assert.equal(linked[0]!.id, 'report-1');
    assert.equal(linked[0]!.repositoryId, 'repo-1');
    assert.equal(linked[0]!.issueNumber, 42);
  });

  it('bugfix: a bug report that ALREADY has a linked GitHub issue returns the existing link and never calls the provider again', async () => {
    let providerCalled = false;
    const linked: Array<{ id: string; repositoryId: string; issueNumber: number; issueUrl: string }> = [];
    const deps: CreateBugReportGitHubIssueDeps = {
      provider: {
        createIssue: async () => { providerCalled = true; return { number: 999, url: 'https://github.com/acme/widgets/issues/999' }; },
      } as never,
      repo: fakeRepoDep(linked),
    };
    const alreadyLinkedReport = fakeReport({ githubRepositoryId: 'repo-1', githubIssueNumber: 7, githubIssueUrl: 'https://github.com/acme/widgets/issues/7' });

    const result = await createGitHubIssueFromBugReport(
      'user-1',
      { id: 'repo-1', organizationId: 'org-1', repoUrl: 'https://github.com/acme/widgets' },
      'org-1',
      alreadyLinkedReport,
      deps,
    );

    assert.equal(result.issueNumber, 7, 'must return the EXISTING issue, never a new one');
    assert.equal(result.issueUrl, 'https://github.com/acme/widgets/issues/7');
    assert.equal(providerCalled, false, 'GitHub must never be called again once a link already exists');
    assert.equal(linked.length, 0, 'nothing new to persist — the link already existed');
  });

  it('maps a provider error (e.g. missing permission) through the SAME mapProviderError every other GitHub issue route uses', async () => {
    const deps: CreateBugReportGitHubIssueDeps = {
      provider: {
        createIssue: async () => { throw new RepositoryProviderError('forbidden', 'RATE_LIMITED'); },
      } as never,
      repo: fakeRepoDep(),
    };
    await assert.rejects(
      () => createGitHubIssueFromBugReport('user-1', { id: 'repo-1', organizationId: 'org-1', repoUrl: 'https://github.com/acme/widgets' }, 'org-1', fakeReport(), deps),
      (error: unknown) => error instanceof GitHubIssueError && error.code === 'GITHUB_PERMISSION_DENIED',
    );
  });
});
