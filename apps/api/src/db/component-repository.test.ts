import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { OrganizationRepository } from './organization-repository.js';
import { ComponentRepository } from './component-repository.js';

/**
 * UX audit follow-up — verifies component-generation jobs have the same
 * real per-organization ownership boundary repositories already have
 * (migration 018). Requires a real Postgres instance — skips rather than
 * fails when DATABASE_URL isn't configured, matching this project's
 * convention (see db/repository-repository.test.ts).
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

describeIfDb('ComponentRepository — organization ownership (migration 018, real Postgres)', () => {
  it('a job created for one organization is returned by getJobForOrganizations for that organization, and only that one', async () => {
    const orgA = await createRealOrganization(`component-org-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`component-org-b-${randomUUID()}`);
    const repo = new ComponentRepository();
    const jobId = randomUUID();

    await repo.createJob({ jobId, organizationId: orgA.id, sourceUrl: 'https://example.com/', target: 'REACT' });

    const foundByOwner = await repo.getJobForOrganizations(jobId, [orgA.id]);
    assert.equal(foundByOwner?.jobId, jobId);
    assert.equal(foundByOwner?.organizationId, orgA.id);

    assert.equal(await repo.getJobForOrganizations(jobId, [orgB.id]), undefined);
  });

  it('listJobsForOrganizations only returns jobs belonging to the given organizations', async () => {
    const orgA = await createRealOrganization(`component-list-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`component-list-b-${randomUUID()}`);
    const repo = new ComponentRepository();
    const jobIdA = randomUUID();

    await repo.createJob({ jobId: jobIdA, organizationId: orgA.id, sourceUrl: 'https://example.com/a', target: 'REACT' });
    await repo.createJob({ jobId: randomUUID(), organizationId: orgB.id, sourceUrl: 'https://example.com/b', target: 'REACT' });

    const listForA = await repo.listJobsForOrganizations([orgA.id]);
    assert.equal(listForA.length, 1);
    assert.equal(listForA[0].jobId, jobIdA);
  });

  it('getJobForOrganizations and listJobsForOrganizations return nothing for an empty organization id list', async () => {
    const org = await createRealOrganization(`component-empty-${randomUUID()}`);
    const repo = new ComponentRepository();
    const jobId = randomUUID();
    await repo.createJob({ jobId, organizationId: org.id, sourceUrl: 'https://example.com/', target: 'REACT' });

    assert.equal(await repo.getJobForOrganizations(jobId, []), undefined);
    assert.deepEqual(await repo.listJobsForOrganizations([]), []);
  });
});
