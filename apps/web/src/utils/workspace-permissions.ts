/**
 * UI-only mirror of apps/api/src/authorization/workspace-permissions.ts —
 * used solely to hide/disable actions a user can't perform. The API
 * remains authoritative regardless; every mutating route re-checks the
 * real role itself server-side (see that file's own doc comment).
 */
import type { OrganizationRole } from '@origami/contracts';

type Role = OrganizationRole | null | undefined;

export function canManageMembers(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canManageBilling(role: Role): boolean {
  return role === 'OWNER';
}

export function canTransferOwnership(role: Role): boolean {
  return role === 'OWNER';
}

export function canConfigureRepository(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function canRunScanOrAI(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
}

export function canMutateRepository(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
