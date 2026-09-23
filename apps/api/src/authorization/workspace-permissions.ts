/**
 * Workspace-level authorization — pure functions over a resolved
 * OrganizationRole. CLIENT_VIEWER returns false from every one of these on
 * purpose: no "share this specific report with an external client"
 * mechanism exists yet (that's explicitly future Agency-plan work — see
 * PLAN_DEFINITIONS.AGENCY.active), so until real per-resource sharing is
 * built, a CLIENT_VIEWER is fail-closed to ordinary workspace resources
 * rather than silently getting the same access as VIEWER. This is the
 * correct interim state, not a placeholder bug.
 */
import type { OrganizationRole } from '@origami/contracts';

type Role = OrganizationRole | undefined;

/** Manage workspace settings/name, and (transitively) everything the other functions below already cover. */
export function canManageWorkspace(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Invite/remove members, change a member's role. Assigning/removing the OWNER role itself and transferring ownership are OWNER-only — see canTransferOwnership. */
export function canManageMembers(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Stripe checkout/portal/seat changes — OWNER only. A workspace ADMIN can run the workspace day-to-day but never touches billing. */
export function canManageBilling(role: Role): boolean {
  return role === 'OWNER';
}

export function canTransferOwnership(role: Role): boolean {
  return role === 'OWNER';
}

/** Connect/disconnect a repository, trigger clone/index/embed — configuration actions, not day-to-day usage. */
export function canConfigureRepository(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Create a scan, ask the repository AI assistant, generate a Screenshot -> Code component, or generate/review a fix proposal — the day-to-day collaborative actions. Excludes VIEWER/CLIENT_VIEWER (read-only) and, implicitly, nobody outside the workspace at all (that boundary is enforced earlier, by organization-membership resolution). */
export function canRunScanOrAI(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
}

/**
 * Actually apply a fix / create a branch, commit, or pull request — the one
 * real source-mutation boundary. Deliberately OWNER/ADMIN only, not MEMBER:
 * membership alone (even active collaboration — generating and reviewing a
 * fix proposal) must never imply the right to mutate a connected
 * repository. A MEMBER can get a proposal all the way to "ready to apply"
 * and then needs an ADMIN/OWNER to actually pull the trigger.
 */
export function canMutateRepository(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Ordinary reads — viewing scans/components/repositories/reports. VIEWER can read everything in the workspace; CLIENT_VIEWER cannot (see the file's doc comment). */
export function canReadWorkspaceResource(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER' || role === 'VIEWER';
}
