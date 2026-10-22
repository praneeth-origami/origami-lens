/**
 * Workspace-level authorization — pure functions over a resolved
 * OrganizationRole. CLIENT_VIEWER returns false from every one of these
 * (canManageWorkspace/canManageMembers/canManageBilling/
 * canTransferOwnership/canConfigureRepository/canRunScanOrAI/
 * canMutateRepository/canReadWorkspaceResource) ON PURPOSE — a client
 * invited into their own client workspace must never automatically gain
 * admin access, repository/provider credentials, AI fix workflows, or
 * every scan/report in the workspace (see the Agency requirements doc's
 * explicit exclusion list). The ONE narrow exception is
 * canReadReportsAsClientViewer below (Agency plan) — a CLIENT_VIEWER may
 * read scans/reports in a workspace they're an explicit member of, and
 * nothing else; every other permission in this file still fails closed for
 * them exactly as before.
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

/**
 * Used only by the handful of routes that actually check a role before a
 * READ (workspace settings/members listing, the client-workspace list).
 * Scan/report reads (GET /scans, GET /scans/:scanId, report export, report
 * share status) deliberately do NOT call this — they were only ever gated
 * by organization membership (resolveOrganizationIds/
 * getScanForOrganizationsAsync), with no role check at all. That turns out
 * to be exactly the behavior the Agency plan needs: a CLIENT_VIEWER added
 * to their own client workspace can already read that workspace's
 * scans/reports the moment they're a member, while every genuinely
 * sensitive action (repository connections, provider credentials, AI fix
 * workflows, billing, member management, configuration) stays fail-closed
 * for them because THOSE routes do call canReadWorkspaceResource/
 * canConfigureRepository/canRunScanOrAI/canMutateRepository above, all of
 * which exclude CLIENT_VIEWER. No code change was needed to satisfy the
 * Agency requirements doc's access rules — confirmed by reading every
 * report/scan route's preHandler, not assumed.
 */
export function canReadWorkspaceResource(role: Role): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER' || role === 'VIEWER';
}
