import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { OrganizationRepository } from './organization-repository.js';
import { ScanRepository } from './scan-repository.js';

/**
 * UX audit follow-up — verifies scans/issues have the same real
 * per-organization ownership boundary repositories already have (migration
 * 018). Requires a real Postgres instance — skips rather than fails when
 * DATABASE_URL isn't configured, matching this project's convention (see
 * db/repository-repository.test.ts).
 */
const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

async function createRealOrganization(login: string) {
  const userRepo = new UserRepository();
  const user = await userRepo.upsertByProviderAccount({
    id: randomUUID(),
    primaryProvider: 'GITHUB',
    primaryProviderAccountId: randomUUID(),
    primaryProviderLogin: login,
    displayName: login,
  });
  const orgRepo = new OrganizationRepository();
  return orgRepo.getOrCreatePersonalOrganization(user.id, login);
}

describeIfDb('ScanRepository — organization ownership (migration 018, real Postgres)', () => {
  it('a scan created for one organization is returned by getScanForOrganizations for that organization, and only that one', async () => {
    const orgA = await createRealOrganization(`scan-org-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-org-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanId = randomUUID();

    await repo.createScan({ scanId, scanType: 'CURRENT_PAGE', rootUrl: 'https://example.com/', organizationId: orgA.id });

    const foundByOwner = await repo.getScanForOrganizations(scanId, [orgA.id]);
    assert.equal(foundByOwner?.scanId, scanId);
    assert.equal(foundByOwner?.organizationId, orgA.id);

    const foundByOther = await repo.getScanForOrganizations(scanId, [orgB.id]);
    assert.equal(foundByOther, undefined);
  });

  it('listScansForOrganizations only returns scans belonging to the given organizations', async () => {
    const orgA = await createRealOrganization(`scan-list-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-list-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanIdA = randomUUID();

    await repo.createScan({ scanId: scanIdA, scanType: 'CURRENT_PAGE', rootUrl: 'https://example.com/a', organizationId: orgA.id });
    await repo.createScan({ scanId: randomUUID(), scanType: 'CURRENT_PAGE', rootUrl: 'https://example.com/b', organizationId: orgB.id });

    const listForA = await repo.listScansForOrganizations([orgA.id]);
    assert.ok(listForA.some((s) => s.scanId === scanIdA));
    assert.equal(listForA.length, 1);
  });

  it('getScanStatusForOrganizations respects organization scoping', async () => {
    const orgA = await createRealOrganization(`scan-status-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-status-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanId = randomUUID();

    await repo.createScan({ scanId, scanType: 'WEBSITE', rootUrl: 'https://example.com/', organizationId: orgA.id, status: 'RUNNING' });

    const status = await repo.getScanStatusForOrganizations(scanId, [orgA.id]);
    assert.equal(status?.status, 'RUNNING');
    assert.equal(await repo.getScanStatusForOrganizations(scanId, [orgB.id]), undefined);
  });

  it('getPageScansForOrganizations: undefined for a scan that is not yours, [] for yours with no pages yet, real pages once created', async () => {
    const orgA = await createRealOrganization(`scan-pages-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-pages-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanId = randomUUID();

    await repo.createScan({ scanId, scanType: 'WEBSITE', rootUrl: 'https://example.com/', organizationId: orgA.id });

    assert.equal(await repo.getPageScansForOrganizations(scanId, [orgB.id]), undefined);
    assert.deepEqual(await repo.getPageScansForOrganizations(scanId, [orgA.id]), []);

    await repo.createPageScan(scanId, 'https://example.com/page');
    const pages = await repo.getPageScansForOrganizations(scanId, [orgA.id]);
    assert.equal(pages?.length, 1);
  });

  it('getIssueForOrganizations / updateIssueStatusForOrganizations: an issue is scoped via its scan\'s organization', async () => {
    const orgA = await createRealOrganization(`scan-issue-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-issue-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanId = randomUUID();

    await repo.createScan({ scanId, scanType: 'WEBSITE', rootUrl: 'https://example.com/', organizationId: orgA.id });
    const pageScanId = await repo.createPageScan(scanId, 'https://example.com/page');
    const issueId = randomUUID();
    await repo.savePageIssues(scanId, pageScanId, [{
      id: issueId,
      category: 'accessibility',
      type: 'test-issue',
      severity: 'LOW',
      title: 'Test issue',
      evidence: {},
      confidence: 0.8,
      impact: 'none',
      source: 'axe-core',
      problem: 'p',
      cause: 'c',
      suggestedFix: 'f',
    }]);

    const foundByOwner = await repo.getIssueForOrganizations(issueId, [orgA.id]);
    assert.equal(foundByOwner?.issue.id, issueId);
    assert.equal(await repo.getIssueForOrganizations(issueId, [orgB.id]), undefined);

    assert.equal(await repo.updateIssueStatusForOrganizations(issueId, 'resolved', [orgB.id]), undefined);
    const updated = await repo.updateIssueStatusForOrganizations(issueId, 'resolved', [orgA.id]);
    assert.equal(updated?.status, 'resolved');
  });

  it('deleteScanForOrganizations only deletes a scan that belongs to the caller, and cascades to its pages/issues', async () => {
    const orgA = await createRealOrganization(`scan-delete-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`scan-delete-b-${randomUUID()}`);
    const repo = new ScanRepository();
    const scanId = randomUUID();

    await repo.createScan({ scanId, scanType: 'WEBSITE', rootUrl: 'https://example.com/', organizationId: orgA.id });
    const pageScanId = await repo.createPageScan(scanId, 'https://example.com/page');
    const issueId = randomUUID();
    await repo.savePageIssues(scanId, pageScanId, [{
      id: issueId,
      category: 'accessibility',
      type: 'test-issue',
      severity: 'LOW',
      title: 'Test issue',
      evidence: {},
      confidence: 0.8,
      impact: 'none',
      source: 'axe-core',
      problem: 'p',
      cause: 'c',
      suggestedFix: 'f',
    }]);

    assert.equal(await repo.deleteScanForOrganizations(scanId, [orgB.id]), false, 'a different organization must not be able to delete it');
    assert.ok(await repo.getScanForOrganizations(scanId, [orgA.id]), 'the scan must still exist after the failed delete attempt');

    assert.equal(await repo.deleteScanForOrganizations(scanId, [orgA.id]), true);
    assert.equal(await repo.getScanForOrganizations(scanId, [orgA.id]), undefined);
    assert.equal(await repo.getIssueForOrganizations(issueId, [orgA.id]), undefined, 'the issue must have cascaded away with its scan');

    assert.equal(await repo.deleteScanForOrganizations(scanId, [orgA.id]), false, 'deleting an already-deleted scan is a no-op, not an error');
  });
});
