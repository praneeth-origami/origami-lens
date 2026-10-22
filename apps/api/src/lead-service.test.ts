import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScanResponse } from '@origami/contracts';
import { LeadError, createLead, type CreateLeadDeps } from './lead-service.js';

function fakeScan(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    scanId: 'scan-1',
    url: 'https://example.com/pricing',
    status: 'COMPLETED',
    healthScore: {
      overallScore: 68,
      categories: {
        functional: { score: 90, weight: 25 }, performance: { score: 40, weight: 20 }, visualMobile: { score: 70, weight: 20 },
        accessibility: { score: 55, weight: 15 }, bestPractices: { score: 80, weight: 10 }, seo: { score: 90, weight: 5 }, securityHygiene: { score: 100, weight: 5 },
      },
    },
    issues: [],
    summary: { totalIssues: 41, critical: 3, high: 12, medium: 20, low: 6, aiAvailable: true },
    scannedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<CreateLeadDeps> = {}): { deps: CreateLeadDeps; created: unknown[]; emails: unknown[] } {
  const created: unknown[] = [];
  const deps: CreateLeadDeps = {
    leadRepo: {
      isEnabled: () => true,
      create: async (input) => { created.push(input); },
    },
    getScanForOrganizations: async () => undefined,
    ...overrides,
  };
  return { deps, created, emails: [] };
}

describe('createLead', () => {
  it('rejects a missing name with NAME_REQUIRED, before ever touching the repository', async () => {
    const { deps, created } = fakeDeps();
    await assert.rejects(
      () => createLead('org-1', { name: '  ', email: 'a@example.com' }, deps),
      (error: unknown) => { assert.ok(error instanceof LeadError); assert.equal(error.code, 'NAME_REQUIRED'); return true; },
    );
    assert.equal(created.length, 0);
  });

  it('rejects an invalid email with EMAIL_INVALID', async () => {
    const { deps } = fakeDeps();
    await assert.rejects(
      () => createLead('org-1', { name: 'Jordan', email: 'not-an-email' }, deps),
      (error: unknown) => { assert.ok(error instanceof LeadError); assert.equal(error.code, 'EMAIL_INVALID'); return true; },
    );
  });

  it('rejects a scanId that does not belong to the caller\'s organization with SCAN_NOT_FOUND (never confirms existence)', async () => {
    const { deps } = fakeDeps({ getScanForOrganizations: async () => undefined });
    await assert.rejects(
      () => createLead('org-1', { name: 'Jordan', email: 'jordan@example.com', scanId: 'scan-1' }, deps),
      (error: unknown) => { assert.ok(error instanceof LeadError); assert.equal(error.code, 'SCAN_NOT_FOUND'); return true; },
    );
  });

  it('records the lead with the caller\'s own organization and no scan context when scanId is omitted', async () => {
    const { deps, created } = fakeDeps();
    const result = await createLead('org-1', { name: 'Jordan Smith', email: 'jordan@example.com', company: 'Acme' }, deps);
    assert.ok(result.id);
    assert.equal(created.length, 1);
    const recorded = created[0] as { organizationId?: string; name: string; email: string; company?: string; scanId?: string };
    assert.equal(recorded.organizationId, 'org-1');
    assert.equal(recorded.name, 'Jordan Smith');
    assert.equal(recorded.email, 'jordan@example.com');
    assert.equal(recorded.company, 'Acme');
    assert.equal(recorded.scanId, undefined);
  });

  it('derives domain, Health Score, and 3-tier issue counts from the caller\'s own scan when scanId is supplied — never client-supplied context', async () => {
    const { deps, created } = fakeDeps({ getScanForOrganizations: async (scanId, orgIds) => {
      assert.equal(scanId, 'scan-1');
      assert.deepEqual(orgIds, ['org-1']);
      return fakeScan();
    } });

    await createLead('org-1', { name: 'Jordan Smith', email: 'jordan@example.com', scanId: 'scan-1' }, deps);

    const recorded = created[0] as { domain?: string; healthScore?: number; issueSummary?: { critical: number; important: number; improvements: number } };
    assert.equal(recorded.domain, 'example.com');
    assert.equal(recorded.healthScore, 68);
    assert.deepEqual(recorded.issueSummary, { critical: 3, important: 12, improvements: 26 });
  });

  it('omits Health Score/issue counts for a scan that has not completed successfully, but still records the lead', async () => {
    const { deps, created } = fakeDeps({ getScanForOrganizations: async () => fakeScan({ status: 'RUNNING' }) });
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com', scanId: 'scan-1' }, deps);
    const recorded = created[0] as { healthScore?: number; issueSummary?: unknown; domain?: string };
    assert.equal(recorded.healthScore, undefined);
    assert.equal(recorded.issueSummary, undefined);
    assert.equal(recorded.domain, 'example.com');
  });

  it('still succeeds and records the lead when the repository is not enabled (no database configured)', async () => {
    let createCalled = false;
    const deps: CreateLeadDeps = {
      leadRepo: { isEnabled: () => false, create: async () => { createCalled = true; } },
      getScanForOrganizations: async () => undefined,
    };
    const result = await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com' }, deps);
    assert.ok(result.id);
    assert.equal(createCalled, false);
  });

  it('never throws when the notification email send fails — the lead is already recorded', async () => {
    const { deps } = fakeDeps({ notificationEmail: 'sales@origami.dev' });
    // sendLeadNotificationEmail will fail internally (no SMTP configured in this test env) — createLead must swallow that, not propagate it.
    const result = await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com' }, deps);
    assert.ok(result.id);
  });
});

describe('createLead — Agency lead audit reports (V4)', () => {
  it('isProspectAudit:true is silently downgraded to false when canUseAgencyFeatures is not provided (every pre-existing caller)', async () => {
    const { deps, created } = fakeDeps();
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com', isProspectAudit: true }, deps);
    assert.equal((created[0] as { isProspectAudit?: boolean }).isProspectAudit, false);
  });

  it('isProspectAudit:true is downgraded to false for a non-Agency organization', async () => {
    const { deps, created } = fakeDeps({ canUseAgencyFeatures: async () => false });
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com', isProspectAudit: true }, deps);
    assert.equal((created[0] as { isProspectAudit?: boolean }).isProspectAudit, false);
  });

  it('isProspectAudit:true is honored for a real Agency organization', async () => {
    const { deps, created } = fakeDeps({ canUseAgencyFeatures: async () => true });
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com', isProspectAudit: true }, deps);
    assert.equal((created[0] as { isProspectAudit?: boolean }).isProspectAudit, true);
  });

  it('isProspectAudit defaults to false when not requested, even for an Agency organization', async () => {
    const { deps, created } = fakeDeps({ canUseAgencyFeatures: async () => true });
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com' }, deps);
    assert.equal((created[0] as { isProspectAudit?: boolean }).isProspectAudit, false);
  });

  it('never calls canUseAgencyFeatures when isProspectAudit was not requested (no unnecessary entitlement lookup)', async () => {
    let called = false;
    const { deps } = fakeDeps({ canUseAgencyFeatures: async () => { called = true; return true; } });
    await createLead('org-1', { name: 'Jordan', email: 'jordan@example.com' }, deps);
    assert.equal(called, false);
  });
});
