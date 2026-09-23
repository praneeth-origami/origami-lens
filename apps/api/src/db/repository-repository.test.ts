import '../load-env.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDatabaseEnabled } from './pool.js';
import { UserRepository } from './user-repository.js';
import { OrganizationRepository } from './organization-repository.js';
import { DuplicateRepositoryError, RepositoryRepository } from './repository-repository.js';

/** Requires a real Postgres instance (migration 016) — skips rather than fails when DATABASE_URL isn't configured, matching this project's convention (see user-repository.test.ts). */
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

describeIfDb('RepositoryRepository — organization ownership (migration 016, real Postgres)', () => {
  it('a repository created for one organization is returned by getByIdForOrganizations for that organization, and only that one', async () => {
    const orgA = await createRealOrganization(`repo-org-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`repo-org-b-${randomUUID()}`);
    const repo = new RepositoryRepository();

    const created = await repo.create({
      id: randomUUID(),
      organizationId: orgA.id,
      repoUrl: `https://github.com/octocat/${randomUUID()}`,
      provider: 'GITHUB',
      branch: 'main',
    });

    const foundByOwner = await repo.getByIdForOrganizations(created.id, [orgA.id]);
    assert.equal(foundByOwner?.id, created.id);
    assert.equal(foundByOwner?.organizationId, orgA.id);

    const foundByOther = await repo.getByIdForOrganizations(created.id, [orgB.id]);
    assert.equal(foundByOther, undefined);
  });

  it('getByIdForOrganizations matches ANY of the caller\'s organization ids, not just the first', async () => {
    const orgA = await createRealOrganization(`repo-multi-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`repo-multi-b-${randomUUID()}`);
    const repo = new RepositoryRepository();

    const created = await repo.create({
      id: randomUUID(),
      organizationId: orgB.id,
      repoUrl: `https://github.com/octocat/${randomUUID()}`,
      provider: 'GITHUB',
      branch: 'main',
    });

    const found = await repo.getByIdForOrganizations(created.id, [orgA.id, orgB.id]);
    assert.equal(found?.id, created.id);
  });

  it('listForOrganizations only returns repositories belonging to the given organizations', async () => {
    const orgA = await createRealOrganization(`repo-list-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`repo-list-b-${randomUUID()}`);
    const repo = new RepositoryRepository();

    const repoA = await repo.create({ id: randomUUID(), organizationId: orgA.id, repoUrl: `https://github.com/octocat/${randomUUID()}`, provider: 'GITHUB', branch: 'main' });
    await repo.create({ id: randomUUID(), organizationId: orgB.id, repoUrl: `https://github.com/octocat/${randomUUID()}`, provider: 'GITHUB', branch: 'main' });

    const listForA = await repo.listForOrganizations([orgA.id]);
    assert.ok(listForA.some((r) => r.id === repoA.id));
    assert.ok(listForA.every((r) => r.organizationId === orgA.id));
  });

  it('the same repoUrl+branch can be connected by two different organizations without a duplicate conflict', async () => {
    const orgA = await createRealOrganization(`repo-dup-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`repo-dup-b-${randomUUID()}`);
    const repo = new RepositoryRepository();
    const repoUrl = `https://github.com/octocat/${randomUUID()}`;

    await repo.create({ id: randomUUID(), organizationId: orgA.id, repoUrl, provider: 'GITHUB', branch: 'main' });
    const second = await repo.create({ id: randomUUID(), organizationId: orgB.id, repoUrl, provider: 'GITHUB', branch: 'main' });

    assert.equal(second.organizationId, orgB.id);
  });

  it('reconnecting the same repoUrl+branch for the same organization throws DuplicateRepositoryError', async () => {
    const org = await createRealOrganization(`repo-selfdup-${randomUUID()}`);
    const repo = new RepositoryRepository();
    const repoUrl = `https://github.com/octocat/${randomUUID()}`;

    await repo.create({ id: randomUUID(), organizationId: org.id, repoUrl, provider: 'GITHUB', branch: 'main' });
    await assert.rejects(
      () => repo.create({ id: randomUUID(), organizationId: org.id, repoUrl, provider: 'GITHUB', branch: 'main' }),
      (error: unknown) => error instanceof DuplicateRepositoryError,
    );
  });

  it('getByIdForOrganizations and listForOrganizations return nothing for an empty organization id list', async () => {
    const org = await createRealOrganization(`repo-empty-${randomUUID()}`);
    const repo = new RepositoryRepository();
    const created = await repo.create({ id: randomUUID(), organizationId: org.id, repoUrl: `https://github.com/octocat/${randomUUID()}`, provider: 'GITHUB', branch: 'main' });

    assert.equal(await repo.getByIdForOrganizations(created.id, []), undefined);
    assert.deepEqual(await repo.listForOrganizations([]), []);
  });

  it('deleteForOrganizations only deletes a repository that belongs to the caller', async () => {
    const orgA = await createRealOrganization(`repo-delete-a-${randomUUID()}`);
    const orgB = await createRealOrganization(`repo-delete-b-${randomUUID()}`);
    const repo = new RepositoryRepository();
    const created = await repo.create({ id: randomUUID(), organizationId: orgA.id, repoUrl: `https://github.com/octocat/${randomUUID()}`, provider: 'GITHUB', branch: 'main' });

    assert.equal(await repo.deleteForOrganizations(created.id, [orgB.id]), false, 'a different organization must not be able to delete it');
    assert.ok(await repo.getByIdForOrganizations(created.id, [orgA.id]), 'the repository must still exist after the failed delete attempt');

    assert.equal(await repo.deleteForOrganizations(created.id, [orgA.id]), true);
    assert.equal(await repo.getByIdForOrganizations(created.id, [orgA.id]), undefined);

    assert.equal(await repo.deleteForOrganizations(created.id, [orgA.id]), false, 'deleting an already-deleted repository is a no-op, not an error');
  });
});
