/**
 * Platform administration — GET /admin/* and PATCH /admin/users/:id/platform-role.
 * Every function here assumes the caller has ALREADY passed
 * canAccessPlatformAdmin/canAssignPlatformRole (authorization/platform-permissions.ts)
 * at the route level; this is the business logic, not the gate itself.
 */
import type {
  AdminErrorCode,
  AdminOverviewResponse,
  AdminUserDetail,
  AdminUserSummary,
  AdminWorkspaceSummary,
  AuthUser,
  OrganizationRole,
  PlatformRole,
  SubscriptionPlan,
  UsageSnapshot,
} from '@origami/contracts';
import type { RecordAuditEventInput, AuditLogEntry } from './db/audit-log-repository.js';
import { countActiveNow, countSubscriptionsByPlanAndStatus, listRecentActivity, sumUsageTodayByPlan } from './admin/activity-repository.js';
import { getWorkerHealthReport } from './admin/worker-health-service.js';
import { checkDependencies } from './health.js';

const ACTIVE_USER_WINDOW_MINUTES = Number(process.env.ADMIN_ACTIVE_USER_WINDOW_MINUTES) || 15;
const DAY_MS = 24 * 60 * 60 * 1000;

export class AdminError extends Error {
  constructor(message: string, public readonly code: AdminErrorCode) {
    super(message);
    this.name = 'AdminError';
  }
}

export interface AdminUserRepo {
  listAll(): Promise<AuthUser[]>;
  getById(id: string): Promise<AuthUser | undefined>;
  updatePlatformRole(id: string, platformRole: PlatformRole): Promise<AuthUser>;
  countByPlatformRole(platformRole: PlatformRole): Promise<number>;
  countCreatedSince(sinceIso: string): Promise<number>;
  countAll(): Promise<number>;
}

export interface AdminOrganizationRepo {
  listAllForAdmin(): Promise<{ id: string; name: string; createdAt: string; ownerEmail?: string }[]>;
  countMembers(organizationId: string): Promise<number>;
  getOrganizationIdsForUser(userId: string): Promise<string[]>;
  getById(organizationId: string): Promise<{ id: string; name: string } | undefined>;
  getPersonalOrganization(userId: string): Promise<{ id: string } | undefined>;
  getMembershipRole(organizationId: string, userId: string): Promise<OrganizationRole | undefined>;
}

export interface AdminSubscriptionRepo {
  findByOrganizationId(organizationId: string): Promise<{ plan: SubscriptionPlan } | undefined>;
}

export interface AdminSessionRepo {
  getLastActiveAt(userId: string): Promise<string | undefined>;
  countActiveSince(windowMinutes: number): Promise<number>;
}

export interface AdminAuditLog {
  record(input: RecordAuditEventInput): Promise<void>;
  listRecent(limit?: number): Promise<AuditLogEntry[]>;
}

export interface AdminServiceDeps {
  userRepo: AdminUserRepo;
  organizationRepo: AdminOrganizationRepo;
  subscriptionRepo: AdminSubscriptionRepo;
  sessionRepo: AdminSessionRepo;
  /** A plain function reference to EntitlementService.getUsageToday (already constructed in index.ts) — injected as a function, not the whole class, so this module never needs to know about billing's DI shape. */
  getUsageToday: (organizationId: string) => Promise<UsageSnapshot[]>;
  auditLog: AdminAuditLog;
}

export async function listUsersForAdmin(deps: AdminServiceDeps): Promise<AdminUserSummary[]> {
  const users = await deps.userRepo.listAll();
  return Promise.all(
    users.map(async (user) => ({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      platformRole: user.platformRole,
      createdAt: user.createdAt,
      workspaceCount: (await deps.organizationRepo.getOrganizationIdsForUser(user.id)).length,
    })),
  );
}

export async function listWorkspacesForAdmin(deps: AdminServiceDeps): Promise<AdminWorkspaceSummary[]> {
  const organizations = await deps.organizationRepo.listAllForAdmin();
  return Promise.all(
    organizations.map(async (org) => {
      const subscription = await deps.subscriptionRepo.findByOrganizationId(org.id);
      return {
        id: org.id,
        name: org.name,
        plan: subscription?.plan ?? 'FREE',
        memberCount: await deps.organizationRepo.countMembers(org.id),
        ownerEmail: org.ownerEmail,
        createdAt: org.createdAt,
      };
    }),
  );
}

/** FOUNDER-only at the route level. Refuses to demote the acting caller if they're the last remaining FOUNDER — the one hard lockout guard in the whole RBAC system. */
export async function updateUserPlatformRole(
  deps: AdminServiceDeps,
  actingUserId: string,
  targetUserId: string,
  platformRole: PlatformRole,
): Promise<AuthUser> {
  const target = await deps.userRepo.getById(targetUserId);
  if (!target) throw new AdminError('User not found.', 'USER_NOT_FOUND');

  if (targetUserId === actingUserId && target.platformRole === 'FOUNDER' && platformRole !== 'FOUNDER') {
    const founderCount = await deps.userRepo.countByPlatformRole('FOUNDER');
    if (founderCount <= 1) {
      throw new AdminError('Cannot demote the last remaining Founder.', 'CANNOT_DEMOTE_LAST_FOUNDER');
    }
  }

  const updated = await deps.userRepo.updatePlatformRole(targetUserId, platformRole);
  await deps.auditLog
    .record({
      actorUserId: actingUserId,
      eventType: 'platform.role.changed',
      targetType: 'user',
      targetId: targetUserId,
      metadata: { platformRole, previousPlatformRole: target.platformRole },
    })
    .catch(() => {});

  return updated;
}

export interface AdminUserSearchFilters {
  search?: string;
  role?: PlatformRole;
  plan?: SubscriptionPlan;
}

/**
 * Extends listUsersForAdmin with the search/role/plan filters section 21/23
 * ask for. A user's "plan" is their PERSONAL organization's plan (plans
 * belong to organizations, not users directly — see PLAN_DEFINITIONS' own
 * doc comment) — the reasonable, common-case approximation for a Team
 * member who has no personal-plan concept of their own.
 *
 * Filters in memory after one listAll() call, matching this project's
 * existing scale (small user counts) and existing listUsersForAdmin's own
 * unbounded-listAll precedent — see the final report's "remaining
 * production considerations" for when this should move into SQL.
 */
export async function searchUsersForAdmin(deps: AdminServiceDeps, filters: AdminUserSearchFilters = {}): Promise<AdminUserSummary[]> {
  const summaries = await listUsersForAdmin(deps);
  const withPlans = await Promise.all(
    summaries.map(async (summary) => {
      const personalOrg = await deps.organizationRepo.getPersonalOrganization(summary.id);
      const subscription = personalOrg ? await deps.subscriptionRepo.findByOrganizationId(personalOrg.id) : undefined;
      return { ...summary, plan: subscription?.plan ?? 'FREE' };
    }),
  );

  const search = filters.search?.trim().toLowerCase();
  return withPlans.filter((user) => {
    if (filters.role && user.platformRole !== filters.role) return false;
    if (filters.plan && user.plan !== filters.plan) return false;
    if (search) {
      const haystack = `${user.email ?? ''} ${user.displayName ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** The user-detail drawer — name/email/platform role/subscription/created/last-active/workspace memberships/usage summary. Never password hash/OAuth tokens: this only ever reads from AuthUser (which never carries them, see its own doc comment in @origami/contracts) plus the same safe columns everything else in this file already uses. */
export async function getUserDetailForAdmin(deps: AdminServiceDeps, userId: string): Promise<AdminUserDetail> {
  const user = await deps.userRepo.getById(userId);
  if (!user) throw new AdminError('User not found.', 'USER_NOT_FOUND');

  const organizationIds = await deps.organizationRepo.getOrganizationIdsForUser(userId);
  const workspaces = (
    await Promise.all(
      organizationIds.map(async (organizationId) => {
        const [organization, role] = await Promise.all([
          deps.organizationRepo.getById(organizationId),
          deps.organizationRepo.getMembershipRole(organizationId, userId),
        ]);
        if (!organization || !role) return undefined;
        return { organizationId, organizationName: organization.name, role };
      }),
    )
  ).filter((w): w is NonNullable<typeof w> => w !== undefined);

  const personalOrg = await deps.organizationRepo.getPersonalOrganization(userId);
  const subscription = personalOrg ? await deps.subscriptionRepo.findByOrganizationId(personalOrg.id) : undefined;
  const usageToday = personalOrg ? await deps.getUsageToday(personalOrg.id) : [];
  const lastActiveAt = await deps.sessionRepo.getLastActiveAt(userId);

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    platformRole: user.platformRole,
    createdAt: user.createdAt,
    workspaceCount: organizationIds.length,
    lastActiveAt,
    subscriptionPlan: subscription?.plan,
    workspaces,
    usageToday,
  };
}

/** The Overview tab's one call — top metrics, Active Now counts, a compact system/worker health summary, subscription/usage breakdowns, and a short recent-activity preview. Deliberately NOT run through the DI-fakes pattern the rest of this file uses: every data source it composes (activity-repository.ts, worker-health-service.ts) is itself a plain, real-Postgres-tested function — see those files' own tests — so wrapping this composition in another layer of injected interfaces would add boilerplate without real safety benefit. */
export async function getAdminOverview(deps: Pick<AdminServiceDeps, 'userRepo' | 'organizationRepo' | 'sessionRepo' | 'auditLog'>): Promise<AdminOverviewResponse> {
  const now = Date.now();
  const startOfToday = new Date(now - (now % DAY_MS)).toISOString();
  const startOfWeek = new Date(now - 7 * DAY_MS).toISOString();

  const [
    totalUsers,
    newUsersToday,
    newUsersThisWeek,
    workspaces,
    activeUsersCount,
    activeNowCounts,
    subscriptions,
    usageToday,
    recentAuditEvents,
    recentJobActivity,
    workerHealth,
    dependencyHealth,
  ] = await Promise.all([
    deps.userRepo.countAll(),
    deps.userRepo.countCreatedSince(startOfToday),
    deps.userRepo.countCreatedSince(startOfWeek),
    deps.organizationRepo.listAllForAdmin(),
    deps.sessionRepo.countActiveSince(ACTIVE_USER_WINDOW_MINUTES),
    countActiveNow(),
    countSubscriptionsByPlanAndStatus(),
    sumUsageTodayByPlan(),
    deps.auditLog.listRecent(10),
    listRecentActivity(10),
    getWorkerHealthReport(),
    checkDependencies(),
  ]);

  const recentActivity = [
    ...recentJobActivity,
    ...recentAuditEvents.map((event) => ({
      id: event.id,
      type: 'FIX_WORKFLOW' as const,
      label: event.eventType.replace(/[._]/g, ' '),
      status: 'COMPLETED',
      targetLabel: event.targetType,
      startedAt: event.createdAt,
      updatedAt: event.createdAt,
    })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);

  return {
    totalUsers,
    newUsersToday,
    newUsersThisWeek,
    totalWorkspaces: workspaces.length,
    activeNow: {
      activeUsers: activeUsersCount,
      activeScans: activeNowCounts.activeScans,
      activeAiJobs: activeNowCounts.activeAiJobs,
      activeRepositoryJobs: activeNowCounts.activeRepositoryJobs,
      activeFixWorkflows: activeNowCounts.activeFixWorkflows,
    },
    systemHealth: {
      postgres: workerHealth.postgres.status,
      redis: workerHealth.redis.status,
      api: dependencyHealth.api.status,
      browserWorker: dependencyHealth.browserWorker.status,
      aiRouter: dependencyHealth.aiRouter.status,
    },
    subscriptions,
    usageToday,
    recentActivity,
  };
}
