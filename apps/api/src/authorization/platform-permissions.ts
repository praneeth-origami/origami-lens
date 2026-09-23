/**
 * Platform-level authorization — pure functions over AuthUser.platformRole.
 * Every platform-role mutation is FOUNDER-only by design: an ADMIN can never
 * create another ADMIN or escalate anyone (including themselves), which
 * closes off the entire "Admin escalates to Founder" attack class by
 * construction rather than by a runtime check that could be missed.
 */
import type { AuthUser } from '@origami/contracts';

export function isFounder(user: Pick<AuthUser, 'platformRole'>): boolean {
  return user.platformRole === 'FOUNDER';
}

export function isPlatformAdmin(user: Pick<AuthUser, 'platformRole'>): boolean {
  return user.platformRole === 'FOUNDER' || user.platformRole === 'ADMIN';
}

/** GET /admin/* read routes (users, workspaces, system health) — FOUNDER or ADMIN. */
export function canAccessPlatformAdmin(user: Pick<AuthUser, 'platformRole'>): boolean {
  return isPlatformAdmin(user);
}

/** PATCH /admin/users/:id/platform-role — FOUNDER only. Assigning/removing ADMIN or FOUNDER is always a Founder-only action; a platform ADMIN never has this permission. */
export function canAssignPlatformRole(user: Pick<AuthUser, 'platformRole'>): boolean {
  return isFounder(user);
}
