import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser } from '@origami/contracts';
import { maybeBootstrapFounder } from './founder-bootstrap.js';

const original = process.env.FOUNDER_BOOTSTRAP_EMAILS;
afterEach(() => {
  if (original === undefined) delete process.env.FOUNDER_BOOTSTRAP_EMAILS;
  else process.env.FOUNDER_BOOTSTRAP_EMAILS = original;
});

function fakeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    primaryProvider: 'GITHUB',
    primaryProviderLogin: 'octocat',
    email: 'founder@example.com',
    platformRole: 'USER',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildDeps() {
  const updateCalls: { id: string; role: string }[] = [];
  const auditCalls: unknown[] = [];
  return {
    updateCalls,
    auditCalls,
    deps: {
      userRepo: {
        updatePlatformRole: async (id: string, platformRole: 'FOUNDER') => {
          updateCalls.push({ id, role: platformRole });
          return fakeUser({ id, platformRole });
        },
      },
      auditLog: { record: async (input: unknown) => { auditCalls.push(input); } },
    },
  };
}

describe('maybeBootstrapFounder', () => {
  it('promotes a matching-email, still-default USER account to FOUNDER and audit-logs it', async () => {
    process.env.FOUNDER_BOOTSTRAP_EMAILS = 'founder@example.com';
    const { deps, updateCalls, auditCalls } = buildDeps();

    const result = await maybeBootstrapFounder(deps, fakeUser());

    assert.equal(result.platformRole, 'FOUNDER');
    assert.equal(updateCalls.length, 1);
    assert.equal(auditCalls.length, 1);
  });

  it('is case-insensitive and trims whitespace/commas in the env var', async () => {
    process.env.FOUNDER_BOOTSTRAP_EMAILS = ' Other@example.com , FOUNDER@EXAMPLE.COM ';
    const { deps, updateCalls } = buildDeps();

    await maybeBootstrapFounder(deps, fakeUser({ email: 'founder@example.com' }));

    assert.equal(updateCalls.length, 1);
  });

  it('does nothing for an email not in the bootstrap list', async () => {
    process.env.FOUNDER_BOOTSTRAP_EMAILS = 'someone-else@example.com';
    const { deps, updateCalls } = buildDeps();

    const result = await maybeBootstrapFounder(deps, fakeUser());

    assert.equal(result.platformRole, 'USER');
    assert.equal(updateCalls.length, 0);
  });

  it('never re-promotes an account that is no longer USER (a revoked Founder stays revoked even if the email is still listed)', async () => {
    process.env.FOUNDER_BOOTSTRAP_EMAILS = 'founder@example.com';
    const { deps, updateCalls } = buildDeps();

    const result = await maybeBootstrapFounder(deps, fakeUser({ platformRole: 'ADMIN' }));

    assert.equal(result.platformRole, 'ADMIN');
    assert.equal(updateCalls.length, 0);
  });

  it('does nothing when the env var is unset', async () => {
    delete process.env.FOUNDER_BOOTSTRAP_EMAILS;
    const { deps, updateCalls } = buildDeps();

    await maybeBootstrapFounder(deps, fakeUser());

    assert.equal(updateCalls.length, 0);
  });

  it('does nothing for a user with no email at all', async () => {
    process.env.FOUNDER_BOOTSTRAP_EMAILS = 'founder@example.com';
    const { deps, updateCalls } = buildDeps();

    await maybeBootstrapFounder(deps, fakeUser({ email: undefined }));

    assert.equal(updateCalls.length, 0);
  });
});
