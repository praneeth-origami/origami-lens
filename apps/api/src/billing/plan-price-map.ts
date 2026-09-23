/**
 * Stripe Price ids are never hardcoded — every plan/interval combination is
 * configured via its own env var (see .env.example's "Stripe Billing"
 * section), created once by scripts/stripe-setup.ts. This is the single
 * place that maps a plan+interval to its price id, and back again (used by
 * the webhook handler to figure out which plan a Stripe subscription
 * represents).
 */
import type { BillingInterval, SubscriptionPlan } from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';

/** AGENCY is intentionally excluded — it has no price ids yet (inactive plan, see PLAN_DEFINITIONS.AGENCY.active). */
const PRICED_PLANS: SubscriptionPlan[] = (Object.keys(PLAN_DEFINITIONS) as SubscriptionPlan[]).filter(
  (plan) => plan !== 'FREE' && PLAN_DEFINITIONS[plan].active,
);

function envKey(plan: SubscriptionPlan, interval: BillingInterval): string {
  return `STRIPE_PRICE_${plan}_${interval}`;
}

export function getPriceId(plan: SubscriptionPlan, interval: BillingInterval): string | undefined {
  return process.env[envKey(plan, interval)]?.trim() || undefined;
}

export function getSeatPriceId(): string | undefined {
  return process.env.STRIPE_PRICE_TEAM_SEAT_MONTHLY?.trim() || undefined;
}

export function resolvePlanAndIntervalFromPriceId(priceId: string): { plan: SubscriptionPlan; interval: BillingInterval } | undefined {
  for (const plan of PRICED_PLANS) {
    if (getPriceId(plan, 'MONTHLY') === priceId) return { plan, interval: 'MONTHLY' };
    if (getPriceId(plan, 'ANNUAL') === priceId) return { plan, interval: 'ANNUAL' };
  }
  return undefined;
}
