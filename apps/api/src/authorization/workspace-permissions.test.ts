import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OrganizationRole } from '@origami/contracts';
import {
  canManageWorkspace,
  canManageMembers,
  canManageBilling,
  canTransferOwnership,
  canConfigureRepository,
  canRunScanOrAI,
  canMutateRepository,
  canReadWorkspaceResource,
} from './workspace-permissions.js';

const ALL_ROLES: (OrganizationRole | undefined)[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'CLIENT_VIEWER', undefined];

function allowedRoles(permission: (role: OrganizationRole | undefined) => boolean): (OrganizationRole | undefined)[] {
  return ALL_ROLES.filter(permission);
}

describe('workspace-permissions — the full test matrix from the RBAC spec', () => {
  it('canManageWorkspace: OWNER/ADMIN only', () => {
    assert.deepEqual(allowedRoles(canManageWorkspace), ['OWNER', 'ADMIN']);
  });

  it('canManageMembers: OWNER/ADMIN only', () => {
    assert.deepEqual(allowedRoles(canManageMembers), ['OWNER', 'ADMIN']);
  });

  it('canManageBilling: OWNER only — a workspace ADMIN can run the workspace but never touches billing', () => {
    assert.deepEqual(allowedRoles(canManageBilling), ['OWNER']);
  });

  it('canTransferOwnership: OWNER only', () => {
    assert.deepEqual(allowedRoles(canTransferOwnership), ['OWNER']);
  });

  it('canConfigureRepository: OWNER/ADMIN only — a MEMBER cannot connect/delete/clone/index/embed a repository', () => {
    assert.deepEqual(allowedRoles(canConfigureRepository), ['OWNER', 'ADMIN']);
  });

  it('canRunScanOrAI: OWNER/ADMIN/MEMBER — VIEWER and CLIENT_VIEWER cannot run a scan, ask AI, or generate a fix proposal', () => {
    assert.deepEqual(allowedRoles(canRunScanOrAI), ['OWNER', 'ADMIN', 'MEMBER']);
  });

  it('canMutateRepository: OWNER/ADMIN only — membership/MEMBER alone never implies the right to apply a fix or create a branch/commit/PR', () => {
    assert.deepEqual(allowedRoles(canMutateRepository), ['OWNER', 'ADMIN']);
  });

  it('canReadWorkspaceResource: OWNER/ADMIN/MEMBER/VIEWER — CLIENT_VIEWER is excluded from ordinary reads (fail-closed until real sharing exists)', () => {
    assert.deepEqual(allowedRoles(canReadWorkspaceResource), ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
  });

  it('no membership at all (undefined role) is denied by every single permission function', () => {
    for (const permission of [
      canManageWorkspace,
      canManageMembers,
      canManageBilling,
      canTransferOwnership,
      canConfigureRepository,
      canRunScanOrAI,
      canMutateRepository,
      canReadWorkspaceResource,
    ]) {
      assert.equal(permission(undefined), false);
    }
  });
});
