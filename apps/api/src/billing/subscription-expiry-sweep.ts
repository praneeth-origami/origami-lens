/**
 * Runs on a plain interval (see index.ts, alongside repository-fix-workflow-service.ts's
 * sweepExpiredFixWorkflows) rather than reacting to a webhook — Stripe pushes
 * no event for "N days until a regular subscription's period ends" (only
 * trial-ending), so this is the one notification in the billing system that
 * has to be discovered by polling instead of triggered by an event.
 */
import type { Subscription, WorkspaceMember } from '@origami/contracts';

export interface SubscriptionExpirySweepRepo {
  findExpiringSoon(withinDays: number): Promise<Subscription[]>;
  claimExpiringSoonNotification(organizationId: string, withinDays: number): Promise<{ currentPeriodEnd: string } | undefined>;
}

export interface SubscriptionExpirySweepOrganizationRepo {
  listMembers(organizationId: string): Promise<WorkspaceMember[]>;
}

export interface SubscriptionExpirySweepDeps {
  subscriptionRepo: SubscriptionExpirySweepRepo;
  organizationRepo: SubscriptionExpirySweepOrganizationRepo;
  sendBillingPlanExpiringSoonEmail(to: string, data: { plan: string; currentPeriodEnd: string; webAppBaseUrl: string }): Promise<void>;
  webAppBaseUrl: string;
  /** How many days out counts as "soon" — default 3. */
  withinDays?: number;
}

/** Returns how many notifications were actually sent (0 is the normal case on most ticks) — useful for logging/tests, never load-bearing. */
export async function sweepExpiringSubscriptions(deps: SubscriptionExpirySweepDeps): Promise<number> {
  const withinDays = deps.withinDays ?? 3;
  const candidates = await deps.subscriptionRepo.findExpiringSoon(withinDays);
  let sent = 0;

  for (const subscription of candidates) {
    try {
      // Re-verifies "still cancelling, still within the window" atomically
      // against the column's live value — see claimExpiringSoonNotification's
      // doc comment for why this can't just reuse subscription.currentPeriodEnd.
      const claim = await deps.subscriptionRepo.claimExpiringSoonNotification(subscription.organizationId, withinDays);
      if (!claim) continue; // Already claimed this period, or no longer a match.

      const members = await deps.organizationRepo.listMembers(subscription.organizationId);
      const owner = members.find((member) => member.role === 'OWNER');
      if (!owner?.email) continue;

      await deps.sendBillingPlanExpiringSoonEmail(owner.email, {
        plan: subscription.plan,
        currentPeriodEnd: claim.currentPeriodEnd,
        webAppBaseUrl: deps.webAppBaseUrl,
      });
      sent += 1;
    } catch (error) {
      console.error('[subscription-expiry-sweep] Failed to notify organization', subscription.organizationId, 'of an expiring plan:', error instanceof Error ? error.message : error);
    }
  }

  return sent;
}
