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
    const seatsUsed = await this.deps.organizationRepo.countMembers(organizationId);
    return {
      plan: subscription.plan,
      limits: definition.limits,
      seatsIncluded: subscription.seatCount,
      seatsUsed,
    };
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
