/**
 * Processes a verified Stripe webhook `event` (signature verification and
 * idempotency-ledger dedup happen in the caller — see billing-service.ts's
 * POST /billing/webhook route). Deliberately takes a plain Stripe.Event, not
 * a raw request, so this is testable with hand-built fake event payloads
 * with no real Stripe signature involved.
 *
 * No custom dunning/retry logic: Stripe's own retry schedule handles a
 * failed payment, and the eventual customer.subscription.deleted event
 * (once Stripe gives up) is what actually reverts the org to FREE.
 */
import type Stripe from 'stripe';
import type { BillingInterval, Subscription, SubscriptionPlan, SubscriptionStatus } from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import { getSeatPriceId, resolvePlanAndIntervalFromPriceId } from './plan-price-map.js';

export interface WebhookSubscriptionRepo {
  findByStripeCustomerId(stripeCustomerId: string): Promise<Subscription | undefined>;
  updateFromStripe(input: {
    organizationId: string;
    plan: SubscriptionPlan;
    status: SubscriptionStatus;
    billingInterval: BillingInterval | null;
    seatCount: number;
    stripeCustomerId: string;
    stripeSubscriptionId: string;
    stripePriceId: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  }): Promise<void>;
  revertToFree(organizationId: string): Promise<void>;
  setStatus(organizationId: string, status: SubscriptionStatus): Promise<void>;
}

export interface StripeWebhookServiceDeps {
  subscriptionRepo: WebhookSubscriptionRepo;
  /** Only needed to expand checkout.session.completed's subscription id into a full Stripe.Subscription — every other event type already carries everything needed in event.data.object. */
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription>;
  /**
   * Billing notification emails — all optional and all best-effort: when
   * omitted (as every existing test in stripe-webhook-service.test.ts does),
   * webhook processing behaves exactly as before, no email is attempted, and
   * a delivery failure never affects the underlying DB write. `getStripe` is
   * used only to resolve the paying customer's email via Stripe's own
   * customer object (this service has no user/organization DB dependency
   * otherwise, and no `expand` is requested on the webhook payload itself).
   */
  getStripe?(): Stripe | null;
  webAppBaseUrl?: string;
  sendBillingSubscriptionStartedEmail?(to: string, data: { plan: string; seatCount?: number; currentPeriodEnd?: string; webAppBaseUrl: string }): Promise<void>;
  sendBillingPaymentSuccessfulEmail?(to: string, data: { amount?: string; plan?: string; webAppBaseUrl: string }): Promise<void>;
  sendBillingPaymentFailedEmail?(to: string, data: { plan?: string; webAppBaseUrl: string }): Promise<void>;
  sendBillingSubscriptionCancelledEmail?(to: string, data: { plan: string; effectiveAt?: string; webAppBaseUrl: string }): Promise<void>;
}

async function notifyBestEffort(label: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`[stripe-webhook-service] Failed to send ${label} email:`, error instanceof Error ? error.message : error);
  }
}

/** Resolves a paying customer's email straight from Stripe (the source of truth for billing identity — it's the same email set at customer.create time in billing-service.ts's createCheckoutSession), never from a local DB join. Returns undefined — never throws — for a deleted customer, a misconfigured Stripe client, or any Stripe API error. */
async function resolveCustomerEmail(deps: StripeWebhookServiceDeps, customerId: string): Promise<string | undefined> {
  const stripe = deps.getStripe?.();
  if (!stripe) return undefined;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if ('deleted' in customer && customer.deleted) return undefined;
    return customer.email ?? undefined;
  } catch (error) {
    console.error('[stripe-webhook-service] Failed to retrieve Stripe customer for a billing notification email:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

function formatInvoiceAmount(amountInCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(amountInCents / 100);
  } catch {
    return `${(amountInCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function priceIdOf(price: string | Stripe.Price): string {
  return typeof price === 'string' ? price : price.id;
}

function customerIdOf(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id;
}

function findBasePlanItem(subscription: Stripe.Subscription): { plan: SubscriptionPlan; interval: BillingInterval; priceId: string } | undefined {
  for (const item of subscription.items.data) {
    const priceId = priceIdOf(item.price);
    const resolved = resolvePlanAndIntervalFromPriceId(priceId);
    if (resolved) return { ...resolved, priceId };
  }
  return undefined;
}

function findSeatQuantity(subscription: Stripe.Subscription): number {
  const seatPriceId = getSeatPriceId();
  if (!seatPriceId) return 0;
  const seatItem = subscription.items.data.find((item) => priceIdOf(item.price) === seatPriceId);
  return seatItem?.quantity ?? 0;
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'INCOMPLETE';
  }
}

async function upsertFromStripeSubscription(subscription: Stripe.Subscription, deps: StripeWebhookServiceDeps): Promise<void> {
  const customerId = customerIdOf(subscription.customer);
  const local = await deps.subscriptionRepo.findByStripeCustomerId(customerId);
  // No local subscription row references this Stripe customer — nothing in
  // our data to attribute this event to (e.g. a stray/manual test object in
  // the Stripe dashboard). Safe to ignore.
  if (!local) return;

  const basePlan = findBasePlanItem(subscription);
  // No line item matches a configured plan price id — can't determine which
  // plan this represents, so there's nothing safe to write. Ignore rather
  // than guess.
  if (!basePlan) return;

  const definition = PLAN_DEFINITIONS[basePlan.plan];
  const seatCount = definition.includedSeats + findSeatQuantity(subscription);

  await deps.subscriptionRepo.updateFromStripe({
    organizationId: local.organizationId,
    plan: basePlan.plan,
    status: mapStripeStatus(subscription.status),
    billingInterval: basePlan.interval,
    seatCount,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: basePlan.priceId,
    currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription, deps: StripeWebhookServiceDeps): Promise<void> {
  const customerId = customerIdOf(subscription.customer);
  const local = await deps.subscriptionRepo.findByStripeCustomerId(customerId);
  if (!local) return;
  const previousPlan = local.plan;
  await deps.subscriptionRepo.revertToFree(local.organizationId);

  if (!deps.sendBillingSubscriptionCancelledEmail || !deps.webAppBaseUrl) return;
  const email = await resolveCustomerEmail(deps, customerId);
  if (!email) return;
  await notifyBestEffort('billing-subscription-cancelled', () =>
    deps.sendBillingSubscriptionCancelledEmail!(email, { plan: previousPlan, webAppBaseUrl: deps.webAppBaseUrl! }),
  );
}

async function handleInvoiceStatus(invoice: Stripe.Invoice, status: SubscriptionStatus, deps: StripeWebhookServiceDeps): Promise<void> {
  // Only a subscription invoice (recurring plan charge) affects our status —
  // a one-off invoice unrelated to any subscription is ignored.
  if (!invoice.subscription) return;
  const customerId = customerIdOf(invoice.customer!);
  const local = await deps.subscriptionRepo.findByStripeCustomerId(customerId);
  if (!local) return;
  await deps.subscriptionRepo.setStatus(local.organizationId, status);

  if (!deps.webAppBaseUrl) return;
  const email = await resolveCustomerEmail(deps, customerId);
  if (!email) return;

  if (status === 'ACTIVE' && deps.sendBillingPaymentSuccessfulEmail) {
    const amount = typeof invoice.amount_paid === 'number' && invoice.amount_paid > 0 ? formatInvoiceAmount(invoice.amount_paid, invoice.currency) : undefined;
    await notifyBestEffort('billing-payment-successful', () =>
      deps.sendBillingPaymentSuccessfulEmail!(email, { amount, plan: local.plan, webAppBaseUrl: deps.webAppBaseUrl! }),
    );
  } else if (status === 'PAST_DUE' && deps.sendBillingPaymentFailedEmail) {
    await notifyBestEffort('billing-payment-failed', () =>
      deps.sendBillingPaymentFailedEmail!(email, { plan: local.plan, webAppBaseUrl: deps.webAppBaseUrl! }),
    );
  }
}

/** Always resolves (never throws for an unhandled/unrecognized event) — the webhook route acks 200 regardless, per Stripe's own recommendation to acknowledge fast and log unhandled types rather than erroring. */
export async function handleStripeWebhookEvent(event: Stripe.Event, deps: StripeWebhookServiceDeps): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session.subscription) return;
      const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
      const subscription = await deps.retrieveSubscription(subscriptionId);
      await upsertFromStripeSubscription(subscription, deps);

      // Only THIS event (the one-time "just subscribed" moment) sends the
      // subscription-started email — customer.subscription.updated below
      // also calls upsertFromStripeSubscription, but fires far more often
      // (seat changes, renewals, proration) and would spam an email on every
      // one of those if it sent from inside the shared upsert helper too.
      if (deps.sendBillingSubscriptionStartedEmail && deps.webAppBaseUrl) {
        const basePlan = findBasePlanItem(subscription);
        if (basePlan) {
          const email = await resolveCustomerEmail(deps, customerIdOf(subscription.customer));
          if (email) {
            const definition = PLAN_DEFINITIONS[basePlan.plan];
            const seatCount = definition.includedSeats + findSeatQuantity(subscription);
            await notifyBestEffort('billing-subscription-started', () =>
              deps.sendBillingSubscriptionStartedEmail!(email, {
                plan: basePlan.plan,
                seatCount,
                currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : undefined,
                webAppBaseUrl: deps.webAppBaseUrl!,
              }),
            );
          }
        }
      }
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await upsertFromStripeSubscription(event.data.object as Stripe.Subscription, deps);
      return;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, deps);
      return;
    case 'invoice.payment_failed':
      await handleInvoiceStatus(event.data.object as Stripe.Invoice, 'PAST_DUE', deps);
      return;
    case 'invoice.payment_succeeded':
      await handleInvoiceStatus(event.data.object as Stripe.Invoice, 'ACTIVE', deps);
      return;
    default:
      // Unhandled event type — acknowledged, not an error.
      return;
  }
}
