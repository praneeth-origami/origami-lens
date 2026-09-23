/**
 * One-time helper: reads PLAN_DEFINITIONS (@origami/contracts) and creates
 * the matching Stripe Products/Prices via the API, then prints the
 * resulting Price ids to paste into .env's "Stripe Billing" section. Not
 * run automatically at boot — run it once, by hand, after setting
 * STRIPE_SECRET_KEY:
 *
 *   pnpm --filter @origami/api exec tsx scripts/stripe-setup.ts
 *
 * Idempotent: re-running it finds and reuses an existing Product (matched
 * by name) and Price (matched by product + interval + amount) instead of
 * creating duplicates, so it's safe to run again after adding a plan.
 */
import '../src/load-env.js';
import Stripe from 'stripe';
import { PLAN_DEFINITIONS, type BillingInterval, type SubscriptionPlan } from '@origami/contracts';

const PRICED_PLANS: SubscriptionPlan[] = (Object.keys(PLAN_DEFINITIONS) as SubscriptionPlan[]).filter(
  (plan) => plan !== 'FREE' && PLAN_DEFINITIONS[plan].active,
);

async function findOrCreateProduct(stripe: Stripe, name: string): Promise<Stripe.Product> {
  const existing = await stripe.products.search({ query: `name:"${name}" AND active:"true"`, limit: 1 });
  if (existing.data[0]) return existing.data[0];
  return stripe.products.create({ name });
}

async function findOrCreatePrice(
  stripe: Stripe,
  product: Stripe.Product,
  unitAmountUsd: number,
  interval: 'month' | 'year',
): Promise<Stripe.Price> {
  const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
  const match = existingPrices.data.find(
    (price) => price.recurring?.interval === interval && price.unit_amount === Math.round(unitAmountUsd * 100),
  );
  if (match) return match;

  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: Math.round(unitAmountUsd * 100),
    recurring: { interval },
  });
}

function envVarName(plan: SubscriptionPlan, interval: BillingInterval): string {
  return `STRIPE_PRICE_${plan}_${interval}`;
}

async function main(): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not set — add a Stripe test-mode secret key to .env first.');
    process.exitCode = 1;
    return;
  }

  const stripe = new Stripe(secretKey);
  const results: Record<string, string> = {};

  for (const plan of PRICED_PLANS) {
    const definition = PLAN_DEFINITIONS[plan];
    const product = await findOrCreateProduct(stripe, `Origami Lens — ${definition.name}`);
    const monthly = await findOrCreatePrice(stripe, product, definition.priceMonthlyUsd, 'month');
    const annual = await findOrCreatePrice(stripe, product, definition.priceAnnualUsd, 'year');
    results[envVarName(plan, 'MONTHLY')] = monthly.id;
    results[envVarName(plan, 'ANNUAL')] = annual.id;
  }

  const teamDefinition = PLAN_DEFINITIONS.TEAM;
  if (teamDefinition.extraSeatPriceMonthlyUsd) {
    const seatProduct = await findOrCreateProduct(stripe, 'Origami Lens — Team extra seat');
    const seatPrice = await findOrCreatePrice(stripe, seatProduct, teamDefinition.extraSeatPriceMonthlyUsd, 'month');
    results.STRIPE_PRICE_TEAM_SEAT_MONTHLY = seatPrice.id;
  }

  console.log('\nPaste these into .env:\n');
  for (const [key, value] of Object.entries(results)) {
    console.log(`${key}=${value}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
