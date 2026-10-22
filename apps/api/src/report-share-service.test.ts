import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { ScanResponse } from '@origami/contracts';
import {
  ReportShareError,
  createOrRotateReportShare,
  getReportShareStatus,
  getSharedReportByToken,
  revokeReportShare,
} from './report-share-service.js';

function fakeScan(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    scanId: 'scan-1',
    url: 'https://example.com',
    status: 'COMPLETED',
    organizationId: 'org-1',
    healthScore: {
      overallScore: 78,
      categories: {
        functional: { score: 84, weight: 25 },
        performance: { score: 71, weight: 20 },
        visualMobile: { score: 79, weight: 20 },
        accessibility: { score: 82, weight: 15 },
        bestPractices: { score: 76, weight: 10 },
        seo: { score: 68, weight: 5 },
        securityHygiene: { score: 91, weight: 5 },
      },
    },
    issues: [],
    summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, aiAvailable: true },
    scannedAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

interface FakeRow {
  id: string;
  scanId: string;
  tokenHash: string;
  revokedAt?: string;
  expiresAt?: string;
}

function isExpired(row: FakeRow): boolean {
  return !!row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
}

function buildFakeRepo() {
  const rows = new Map<string, FakeRow>();
  const createCalls: unknown[] = [];

  const shareLinkRepo = {
    create: async (input: { id: string; scanId: string; tokenHash: string; createdBy?: string; expiresAt?: string }) => {
      createCalls.push(input);
      rows.set(input.id, { id: input.id, scanId: input.scanId, tokenHash: input.tokenHash, expiresAt: input.expiresAt });
    },
    findActiveByScanId: async (scanId: string) => {
      for (const row of rows.values()) {
        if (row.scanId === scanId && !row.revokedAt && !isExpired(row)) return { id: row.id, expiresAt: row.expiresAt };
      }
      return undefined;
    },
    findValidByTokenHash: async (tokenHash: string) => {
      for (const row of rows.values()) {
        if (row.tokenHash === tokenHash && !row.revokedAt && !isExpired(row)) return { scanId: row.scanId };
      }
      return undefined;
    },
    revokeActiveByScanId: async (scanId: string) => {
      for (const row of rows.values()) {
        if (row.scanId === scanId && !row.revokedAt) row.revokedAt = new Date().toISOString();
      }
    },
  };

  return { shareLinkRepo, rows, createCalls };
}

function buildFakeScanStore(scans: Record<string, ScanResponse>, orgOwnership: Record<string, string[]>) {
  return {
    getScanForOrganizationsAsync: async (scanId: string, organizationIds: string[]) => {
      const scan = scans[scanId];
      if (!scan) return undefined;
      const owningOrgs = orgOwnership[scanId] ?? [];
      const authorized = owningOrgs.some((org) => organizationIds.includes(org));
      return authorized ? scan : undefined;
    },
    getScanAsync: async (scanId: string) => scans[scanId],
  };
}

describe('createOrRotateReportShare', () => {
  it('creates a share link for an owned, completed scan and returns a working url', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const result = await createOrRotateReportShare(
      { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' },
      'scan-1',
      ['org-1'],
      randomUUID(),
    );
    assert.ok(result.token.length > 0);
    assert.equal(result.url, `http://localhost:5173/reports/share/${result.token}`);
  });

  it('never stores the raw token — only its hash', async () => {
    const { shareLinkRepo, createCalls } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const result = await createOrRotateReportShare({ shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' }, 'scan-1', ['org-1'], 'user-1');
    const expectedHash = createHash('sha256').update(result.token).digest('hex');
    assert.equal((createCalls[0] as { tokenHash: string }).tokenHash, expectedHash);
    assert.ok(!JSON.stringify(createCalls).includes(result.token));
  });

  it('rejects a scan the caller does not own with SCAN_NOT_FOUND (never reveals it exists)', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-owner'] });
    await assert.rejects(
      () => createOrRotateReportShare({ shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' }, 'scan-1', ['org-intruder'], 'user-1'),
      (error: unknown) => error instanceof ReportShareError && error.code === 'SCAN_NOT_FOUND',
    );
  });

  it('rejects a scan that has not completed successfully with REPORT_NOT_READY', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan({ status: 'FAILED' }) }, { 'scan-1': ['org-1'] });
    await assert.rejects(
      () => createOrRotateReportShare({ shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' }, 'scan-1', ['org-1'], 'user-1'),
      (error: unknown) => error instanceof ReportShareError && error.code === 'REPORT_NOT_READY',
    );
  });

  it('rotating invalidates the previous link — old token no longer resolves', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const first = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');
    const second = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');

    await assert.rejects(
      () => getSharedReportByToken({ shareLinkRepo, scanStore }, first.token),
      (error: unknown) => error instanceof ReportShareError && error.code === 'REPORT_SHARE_NOT_FOUND',
    );
    const report = await getSharedReportByToken({ shareLinkRepo, scanStore }, second.token);
    assert.equal(report.scanId, 'scan-1');
  });
});

describe('getReportShareStatus', () => {
  it('reports active:false when no link exists, active:true after creating one', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };

    assert.deepEqual(await getReportShareStatus(deps, 'scan-1', ['org-1']), { active: false, expiresAt: undefined });
    await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');
    assert.deepEqual(await getReportShareStatus(deps, 'scan-1', ['org-1']), { active: true, expiresAt: undefined });
  });

  it('rejects for an unauthorized organization', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-owner'] });
    await assert.rejects(
      () => getReportShareStatus({ shareLinkRepo, scanStore }, 'scan-1', ['org-intruder']),
      (error: unknown) => error instanceof ReportShareError && error.code === 'SCAN_NOT_FOUND',
    );
  });
});

describe('revokeReportShare', () => {
  it('disables the active link — public lookup then fails', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const { token } = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');

    await revokeReportShare(deps, 'scan-1', ['org-1']);

    assert.deepEqual(await getReportShareStatus(deps, 'scan-1', ['org-1']), { active: false, expiresAt: undefined });
    await assert.rejects(
      () => getSharedReportByToken(deps, token),
      (error: unknown) => error instanceof ReportShareError && error.code === 'REPORT_SHARE_NOT_FOUND',
    );
  });

  it('rejects revoking a scan the caller does not own', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-owner'] });
    await assert.rejects(
      () => revokeReportShare({ shareLinkRepo, scanStore }, 'scan-1', ['org-intruder']),
      (error: unknown) => error instanceof ReportShareError && error.code === 'SCAN_NOT_FOUND',
    );
  });
});

describe('getSharedReportByToken', () => {
  it('resolves the public report without any organization/auth check — the token IS the authorization', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const { token } = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');

    const report = await getSharedReportByToken({ shareLinkRepo, scanStore }, token);
    assert.equal(report.reportVersion, '1.0');
    assert.equal(report.healthScore, 78);
  });

  it('rejects an unknown token with REPORT_SHARE_NOT_FOUND', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({}, {});
    await assert.rejects(
      () => getSharedReportByToken({ shareLinkRepo, scanStore }, 'not-a-real-token'),
      (error: unknown) => error instanceof ReportShareError && error.code === 'REPORT_SHARE_NOT_FOUND',
    );
  });

  it('Agency white-label (V4): resolves branding via the injected resolveBranding function and attaches it to the report', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const { token } = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');

    let resolvedWithOrgId: string | undefined;
    const report = await getSharedReportByToken(
      { shareLinkRepo, scanStore, resolveBranding: async (orgId) => { resolvedWithOrgId = orgId; return { displayName: 'Acme Agency' }; } },
      token,
    );
    assert.equal(resolvedWithOrgId, 'org-1');
    assert.deepEqual(report.branding, { displayName: 'Acme Agency' });
  });

  it('omits branding entirely when resolveBranding is not provided (every pre-existing caller)', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const { token } = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');

    const report = await getSharedReportByToken({ shareLinkRepo, scanStore }, token);
    assert.equal(report.branding, undefined);
  });
});

describe('Agency client share link expiration (V4)', () => {
  it('createOrRotateReportShare with no expiresInDays creates a link that never expires (existing behavior unchanged)', async () => {
    const { shareLinkRepo, createCalls } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };

    const result = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1');
    assert.equal(result.expiresAt, undefined);
    assert.equal((createCalls[0] as { expiresAt?: string }).expiresAt, undefined);
  });

  it('createOrRotateReportShare with expiresInDays sets a real future expiresAt', async () => {
    const { shareLinkRepo } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };

    const before = Date.now();
    const result = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1', 7);
    assert.ok(result.expiresAt);
    const expiresMs = new Date(result.expiresAt!).getTime();
    assert.ok(expiresMs > before + 6 * 24 * 60 * 60 * 1000 && expiresMs <= before + 7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('an EXPIRED link is rejected exactly like a revoked one — REPORT_SHARE_NOT_FOUND, never a stale report', async () => {
    const { shareLinkRepo, rows } = buildFakeRepo();
    const scanStore = buildFakeScanStore({ 'scan-1': fakeScan() }, { 'scan-1': ['org-1'] });
    const deps = { shareLinkRepo, scanStore, webAppBaseUrl: 'http://localhost:5173' };
    const { token } = await createOrRotateReportShare(deps, 'scan-1', ['org-1'], 'user-1', 7);

    // Simulate time passing past the expiration, directly on the fake row (no real clock mocking needed).
    for (const row of rows.values()) row.expiresAt = new Date(Date.now() - 1000).toISOString();

    await assert.rejects(
      () => getSharedReportByToken({ shareLinkRepo, scanStore }, token),
      (error: unknown) => error instanceof ReportShareError && error.code === 'REPORT_SHARE_NOT_FOUND',
    );
    assert.deepEqual(await getReportShareStatus(deps, 'scan-1', ['org-1']), { active: false, expiresAt: undefined });
  });
});
