import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformRole } from '@origami/contracts';
import { isFounder, isPlatformAdmin, canAccessPlatformAdmin, canAssignPlatformRole } from './platform-permissions.js';

function user(platformRole: PlatformRole) {
  return { platformRole };
}

describe('platform-permissions', () => {
  it('isFounder is true only for FOUNDER', () => {
    assert.equal(isFounder(user('FOUNDER')), true);
    assert.equal(isFounder(user('ADMIN')), false);
    assert.equal(isFounder(user('USER')), false);
  });

  it('isPlatformAdmin is true for FOUNDER and ADMIN, false for USER', () => {
    assert.equal(isPlatformAdmin(user('FOUNDER')), true);
    assert.equal(isPlatformAdmin(user('ADMIN')), true);
    assert.equal(isPlatformAdmin(user('USER')), false);
  });

  it('canAccessPlatformAdmin matches isPlatformAdmin exactly (FOUNDER/ADMIN allowed, USER denied)', () => {
    assert.equal(canAccessPlatformAdmin(user('FOUNDER')), true);
    assert.equal(canAccessPlatformAdmin(user('ADMIN')), true);
    assert.equal(canAccessPlatformAdmin(user('USER')), false);
  });

  it('canAssignPlatformRole is FOUNDER-only — a platform ADMIN can never grant/revoke ADMIN or FOUNDER', () => {
    assert.equal(canAssignPlatformRole(user('FOUNDER')), true);
    assert.equal(canAssignPlatformRole(user('ADMIN')), false);
    assert.equal(canAssignPlatformRole(user('USER')), false);
  });
});
