/**
 * The single centralized billing policy object — the only place plan logic
 * lives. Routes and middleware call getEntitlements()/checkAndConsumeQuota()
 * and never inspect `subscription.plan` or PLAN_DEFINITIONS directly, so
 * there is exactly one place to change if a limit or plan mapping changes.
 */
import type { Entitlements, PlanLimits, Subscription, SubscriptionPlan, UsageMetric, UsageSnapshot, WorkspaceMember } from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import { currentUsageDate } from '../db/usage-counter-repository.js';

export interface EntitlementSubscriptionRepo {
  getOrCreateForOrganization(organizationId: string): Promise<Subscription>;
}

export interface EntitlementUsageCounterRepo {
  tryConsume(organizationId: string, metric: UsageMetric, usageDate: string, limit: number): Promise<{ allowed: boolean; count: number }>;
  getCount(organizationId: string, metric: UsageMetric, usageDate: string): Promise<number>;
  /** Debounces the plan-limit-reached email to once per (organization, metric, day) — see usage-counter-repository.ts's doc comment. */
  claimLimitReachedNotification(organizationId: string, metric: UsageMetric, usageDate: string): Promise<boolean>;
}

export interface EntitlementOrganizationRepo {
  countMembers(organizationId: string): Promise<number>;
  /** Internal (non-CLIENT_VIEWER) members only — see organization-repository.ts's own doc comment. A CLIENT_VIEWER was never functionally usable before the Agency plan (every permission check denied it), so this is a no-op for any plan's pre-existing usage and only changes behavior once CLIENT_VIEWER memberships actually exist. */
  countInternalMembers(organizationId: string): Promise<number>;
  listMembers(organizationId: string): Promise<WorkspaceMember[]>;
}

export interface EntitlementServiceDeps {
  subscriptionRepo: EntitlementSubscriptionRepo;
  usageCounterRepo: EntitlementUsageCounterRepo;
  organizationRepo: EntitlementOrganizationRepo;
  /**
   * Plan-limit-reached notification — both optional, so every existing test
   * (which omits them) continues to behave exactly as before: no email
   * attempted. A real caller (index.ts) always provides them. A delivery
   * failure never affects whether the request itself is allowed/blocked.
   */
  sendBillingPlanLimitReachedEmail?(to: string, data: { plan: string; resource?: string; resetAt?: string; webAppBaseUrl: string }): Promise<void>;
  webAppBaseUrl?: string;
}

/** The exact boundary currentUsageDate() (usage-counter-repository.ts) already meters against — next UTC midnight after "now", as an ISO string. Shared by usage-limit-middleware.ts's 402 response and this file's plan-limit-reached email, so both ever quote the same reset time. */
export function nextUsageResetAt(): string {
  const now = new Date();
  const nextMidnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return nextMidnightUtc.toISOString();
}

const METRIC_RESOURCE_LABEL: Record<UsageMetric, string> = {
  INSPECTION: 'Scans',
  AI_QUESTION: 'AI questions',
  SCREENSHOT_TO_CODE: 'Screenshot-to-code generations',
};

export interface QuotaCheckResult {
  allowed: boolean;
  limit: number | null;
  remaining: number | null;
  plan: SubscriptionPlan;
}

const METRIC_LIMIT_KEY: Record<UsageMetric, keyof PlanLimits> = {
  INSPECTION: 'inspectionsPerDay',
  AI_QUESTION: 'aiQuestionsPerDay',
  SCREENSHOT_TO_CODE: 'screenshotToCodePerDay',
};

export class EntitlementService {
  constructor(private readonly deps: EntitlementServiceDeps) {}

  async getEntitlements(organizationId: string): Promise<Entitlements> {
    const subscription = await this.deps.subscriptionRepo.getOrCreateForOrganization(organizationId);
    const definition = PLAN_DEFINITIONS[subscription.plan];
    const seatsUsed = await this.deps.organizationRepo.countInternalMembers(organizationId);
    return {
      plan: subscription.plan,
      limits: definition.limits,
      seatsIncluded: subscription.seatCount,
      seatsUsed,
    };
  }

  /**
   * Agency plan (V4) hard seat cap — distinct from Team's economic
   * overage-billing model (updateSeats charges for extra seats instead of
   * blocking them). `limits.internalSeatHardCap` is `null` for every plan
   * except Agency, so this is always `{allowed: true}` for Free/Developer/
   * Pro/Team — a pure no-op preserving their exact current behavior.
   * Called BEFORE inviting/adding a non-CLIENT_VIEWER member; a
   * CLIENT_VIEWER invite never consults this at all (see call sites).
   */
  async checkSeatCapacity(organizationId: string): Promise<{ allowed: boolean; limit: number | null; used: number }> {
    const entitlements = await this.getEntitlements(organizationId);
    const limit = entitlements.limits.internalSeatHardCap;
    const used = await this.deps.organizationRepo.countInternalMembers(organizationId);
    if (limit === null) return { allowed: true, limit: null, used };
    return { allowed: used < limit, limit, used };
  }

  async getUsageToday(organizationId: string): Promise<UsageSnapshot[]> {
    const entitlements = await this.getEntitlements(organizationId);
    const usageDate = currentUsageDate();
    const metrics: UsageMetric[] = ['INSPECTION', 'AI_QUESTION', 'SCREENSHOT_TO_CODE'];
    return Promise.all(
      metrics.map(async (metric) => {
        const limit = entitlements.limits[METRIC_LIMIT_KEY[metric]];
        const count = await this.deps.usageCounterRepo.getCount(organizationId, metric, usageDate);
        return { metric, count, limit };
      }),
    );
  }

  /** Skips the usage-counter write entirely for an unlimited plan (limit === null) — cheap, and there's nothing to meter. Otherwise delegates to the atomic tryConsume primitive; see usage-counter-repository.ts's doc comment for the race-safety argument. */
  async checkAndConsumeQuota(organizationId: string, metric: UsageMetric): Promise<QuotaCheckResult> {
    const entitlements = await this.getEntitlements(organizationId);
    const limit = entitlements.limits[METRIC_LIMIT_KEY[metric]];
    if (limit === null) return { allowed: true, limit: null, remaining: null, plan: entitlements.plan };

    const usageDate = currentUsageDate();
    const { allowed, count } = await this.deps.usageCounterRepo.tryConsume(organizationId, metric, usageDate, limit);
    if (!allowed) {
      await this.notifyLimitReachedBestEffort(organizationId, metric, usageDate, entitlements.plan);
    }
    return { allowed, limit, remaining: Math.max(0, limit - count), plan: entitlements.plan };
  }

  /**
   * Continuous Monitoring (V3) capacity gate — deliberately NOT a
   * checkAndConsumeQuota-style per-day metered counter (monitored sites
   * aren't "consumed" daily, they're a persistent count), so this is a
   * plain capacity comparison against PlanLimits.monitoredWebsitesIncluded
   * instead of a usage_counters write. `currentEnabledCount` is supplied
   * by the caller (MonitoredSiteRepository.countEnabledForOrganization) —
   * this service never queries monitoring's own tables directly, keeping
   * entitlement-service.ts feature-agnostic.
   */
  async canCreateMonitoredSite(organizationId: string, currentEnabledCount: number): Promise<{ allowed: boolean; limit: number | null; plan: SubscriptionPlan }> {
    const entitlements = await this.getEntitlements(organizationId);
    const limit = entitlements.limits.monitoredWebsitesIncluded;
    if (limit === null) return { allowed: true, limit: null, plan: entitlements.plan };
    return { allowed: currentEnabledCount < limit, limit, plan: entitlements.plan };
  }

  /** Agency plan (V4) — client-workspace management and white-label branding are both flagship Agency capabilities with no separate numeric limit specified by the product requirements (explicitly: do not invent commercial tiers beyond what's asked) — gated as a simple plan check, the same boolean-capability shape Continuous Monitoring's monitoredWebsitesIncluded uses when its limit is 0 vs non-zero. */
  async canManageClientWorkspaces(organizationId: string): Promise<boolean> {
    const entitlements = await this.getEntitlements(organizationId);
    return entitlements.plan === 'AGENCY';
  }

  async canUseWhiteLabelBranding(organizationId: string): Promise<boolean> {
    const entitlements = await this.getEntitlements(organizationId);
    return entitlements.plan === 'AGENCY';
  }

  private async notifyLimitReachedBestEffort(organizationId: string, metric: UsageMetric, usageDate: string, plan: SubscriptionPlan): Promise<void> {
    if (!this.deps.sendBillingPlanLimitReachedEmail || !this.deps.webAppBaseUrl) return;
    try {
      const claimed = await this.deps.usageCounterRepo.claimLimitReachedNotification(organizationId, metric, usageDate);
      if (!claimed) return; // Another blocked request today already sent this.

      const members = await this.deps.organizationRepo.listMembers(organizationId);
      const owner = members.find((member) => member.role === 'OWNER');
      if (!owner?.email) return;

      await this.deps.sendBillingPlanLimitReachedEmail(owner.email, {
        plan,
        resource: METRIC_RESOURCE_LABEL[metric],
        resetAt: nextUsageResetAt(),
        webAppBaseUrl: this.deps.webAppBaseUrl,
      });
    } catch (error) {
      console.error('[entitlement-service] Failed to send a plan-limit-reached email:', error instanceof Error ? error.message : error);
    }
  }
}
