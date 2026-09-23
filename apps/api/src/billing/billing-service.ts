/**
 * Business logic for every /billing/* route — index.ts registers the actual
 * Fastify routes and calls these functions, matching this codebase's
 * existing convention (see repository-ai-service.ts's answerRepositoryQuestion).
 * POST /billing/webhook is the one exception: registerStripeWebhookRoute
 * below registers the whole route itself, since it needs a raw-body content
 * type parser scoped to just that route (see its own doc comment).
 */
import type Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import type {
  BillingErrorCode,
  BillingStatusResponse,
  CreateBillingPortalSessionResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  Subscription,
} from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import type { EntitlementService } from './entitlement-service.js';
import { getPriceId, getSeatPriceId } from './plan-price-map.js';
import { isStripeConfigured } from './stripe-client.js';
import { handleStripeWebhookEvent, type StripeWebhookServiceDeps } from './stripe-webhook-service.js';

export class BillingError extends Error {
  constructor(message: string, public readonly code: BillingErrorCode) {
    super(message);
    this.name = 'BillingError';
  }
}

export interface BillingSubscriptionRepo {
  getOrCreateForOrganization(organizationId: string): Promise<Subscription>;
  findStripeCustomerId(organizationId: string): Promise<string | undefined>;
  findStripeSubscriptionId(organizationId: string): Promise<string | undefined>;
  setStripeCustomerId(organizationId: string, stripeCustomerId: string): Promise<void>;
  setSeatCount(organizationId: string, seatCount: number): Promise<void>;
}

export async function getBillingStatus(
  entitlementService: EntitlementService,
  subscriptionRepo: BillingSubscriptionRepo,
  organizationId: string,
): Promise<BillingStatusResponse> {
  const subscription = await subscriptionRepo.getOrCreateForOrganization(organizationId);
  const entitlements = await entitlementService.getEntitlements(organizationId);
  const usageToday = await entitlementService.getUsageToday(organizationId);
  return { subscription, entitlements, usageToday, billingConfigured: isStripeConfigured() };
}

export interface CheckoutDeps {
  stripe: Stripe | null;
  subscriptionRepo: BillingSubscriptionRepo;
  webAppBaseUrl: string;
  organizationName: string;
  customerEmail?: string;
}

export async function createCheckoutSession(
  deps: CheckoutDeps,
  organizationId: string,
  request: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> {
  if (!deps.stripe) throw new BillingError('Billing is not configured on this server.', 'BILLING_NOT_CONFIGURED');

  const definition = PLAN_DEFINITIONS[request.plan];
  if (!definition || !definition.active || request.plan === 'FREE') {
    throw new BillingError(`${request.plan} is not available for purchase.`, 'INVALID_PLAN');
  }
  if (request.plan === 'TEAM' && request.seats !== undefined && request.seats < definition.includedSeats) {
    throw new BillingError(`Team requires at least ${definition.includedSeats} seats.`, 'SEAT_COUNT_INVALID');
  }

  const priceId = getPriceId(request.plan, request.interval);
  if (!priceId) {
    throw new BillingError(`No Stripe price configured for ${request.plan}/${request.interval}.`, 'BILLING_NOT_CONFIGURED');
  }

  let stripeCustomerId = await deps.subscriptionRepo.findStripeCustomerId(organizationId);
  if (!stripeCustomerId) {
    const customer = await deps.stripe.customers.create({ name: deps.organizationName, email: deps.customerEmail });
    stripeCustomerId = customer.id;
    await deps.subscriptionRepo.setStripeCustomerId(organizationId, stripeCustomerId);
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: priceId, quantity: 1 }];
  if (request.plan === 'TEAM' && request.seats) {
    const extraSeats = Math.max(0, request.seats - definition.includedSeats);
    if (extraSeats > 0) {
      const seatPriceId = getSeatPriceId();
      if (!seatPriceId) throw new BillingError('No Stripe seat price configured for Team.', 'BILLING_NOT_CONFIGURED');
      lineItems.push({ price: seatPriceId, quantity: extraSeats });
    }
  }

  const session = await deps.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: lineItems,
    success_url: `${deps.webAppBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.webAppBaseUrl}/billing/cancel`,
  });

  if (!session.url) throw new BillingError('Stripe did not return a checkout URL.', 'BILLING_NOT_CONFIGURED');
  return { url: session.url };
}

export interface PortalDeps {
  stripe: Stripe | null;
  subscriptionRepo: Pick<BillingSubscriptionRepo, 'findStripeCustomerId'>;
  webAppBaseUrl: string;
}

export async function createBillingPortalSession(deps: PortalDeps, organizationId: string): Promise<CreateBillingPortalSessionResponse> {
  if (!deps.stripe) throw new BillingError('Billing is not configured on this server.', 'BILLING_NOT_CONFIGURED');

  const stripeCustomerId = await deps.subscriptionRepo.findStripeCustomerId(organizationId);
  if (!stripeCustomerId) throw new BillingError('No billing account exists yet for this organization.', 'ORGANIZATION_NOT_FOUND');

  const portalSession = await deps.stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${deps.webAppBaseUrl}/billing/settings`,
  });
  return { url: portalSession.url };
}

export interface CheckoutSessionStatusResult {
  status: Stripe.Checkout.Session.Status | null;
  subscription: Subscription;
}

/** Backs the success page's polling loop — reports Stripe's own session status alongside whatever the LOCAL subscription currently says, without writing anything. The webhook remains the only path that ever changes subscription state; this never "helps it along." */
export async function getCheckoutSessionStatus(
  stripe: Stripe | null,
  subscriptionRepo: Pick<BillingSubscriptionRepo, 'getOrCreateForOrganization'>,
  organizationId: string,
  sessionId: string,
): Promise<CheckoutSessionStatusResult> {
  if (!stripe) throw new BillingError('Billing is not configured on this server.', 'BILLING_NOT_CONFIGURED');

  const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => undefined);
  if (!session) throw new BillingError('Checkout session not found.', 'CHECKOUT_SESSION_NOT_FOUND');

  const subscription = await subscriptionRepo.getOrCreateForOrganization(organizationId);
  return { status: session.status, subscription };
}

export interface UpdateSeatsDeps {
  stripe: Stripe | null;
  subscriptionRepo: BillingSubscriptionRepo;
}

export async function updateSeats(deps: UpdateSeatsDeps, organizationId: string, seats: number): Promise<void> {
  if (!deps.stripe) throw new BillingError('Billing is not configured on this server.', 'BILLING_NOT_CONFIGURED');

  const subscription = await deps.subscriptionRepo.getOrCreateForOrganization(organizationId);
  if (subscription.plan !== 'TEAM') {
    throw new BillingError('Seat management is only available on the Team plan.', 'INVALID_PLAN');
  }

  const definition = PLAN_DEFINITIONS.TEAM;
  if (!Number.isInteger(seats) || seats < definition.includedSeats) {
    throw new BillingError(`Team requires at least ${definition.includedSeats} seats.`, 'SEAT_COUNT_INVALID');
  }

  const stripeSubscriptionId = await deps.subscriptionRepo.findStripeSubscriptionId(organizationId);
  if (!stripeSubscriptionId) throw new BillingError('No active Stripe subscription found.', 'ORGANIZATION_NOT_FOUND');

  const seatPriceId = getSeatPriceId();
  const extraSeats = Math.max(0, seats - definition.includedSeats);

  const stripeSubscription = await deps.stripe.subscriptions.retrieve(stripeSubscriptionId);
  const existingSeatItem = stripeSubscription.items.data.find(
    (item) => (typeof item.price === 'string' ? item.price : item.price.id) === seatPriceId,
  );

  if (extraSeats > 0) {
    if (!seatPriceId) throw new BillingError('No Stripe seat price configured for Team.', 'BILLING_NOT_CONFIGURED');
    if (existingSeatItem) {
      await deps.stripe.subscriptionItems.update(existingSeatItem.id, { quantity: extraSeats });
    } else {
      await deps.stripe.subscriptionItems.create({ subscription: stripeSubscriptionId, price: seatPriceId, quantity: extraSeats });
    }
  } else if (existingSeatItem) {
    await deps.stripe.subscriptionItems.del(existingSeatItem.id);
  }

  // customer.subscription.updated will also fire and re-sync this via the
  // webhook (the real source of truth) — set it locally too just so the UI
  // doesn't lag behind waiting for that round trip.
  await deps.subscriptionRepo.setSeatCount(organizationId, seats);
}

export interface StripeWebhookRouteDeps extends StripeWebhookServiceDeps {
  /** Required here (StripeWebhookServiceDeps declares it optional, since most of that service's tests never provide it) — the route itself cannot function without a Stripe client to verify the incoming signature. */
  getStripe(): Stripe | null;
  getWebhookSecret(): string | undefined;
  eventRepo: { markProcessed(eventId: string, type: string): Promise<boolean> };
}

/**
 * Registers POST /billing/webhook inside its own encapsulated Fastify
 * plugin scope so a route-local `addContentTypeParser` can capture the RAW
 * request body as a Buffer — Stripe signature verification
 * (stripe.webhooks.constructEvent) requires the exact bytes Stripe sent,
 * which the app's normal global JSON body parser would otherwise already
 * have parsed/mutated by the time a handler saw it. Fastify's plugin
 * encapsulation means this parser applies ONLY to routes registered inside
 * this same `instance`, never to any other route on `app`.
 */
export async function registerStripeWebhookRoute(app: FastifyInstance, deps: StripeWebhookRouteDeps): Promise<void> {
  await app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    instance.post('/billing/webhook', async (request, reply) => {
      const stripe = deps.getStripe();
      const webhookSecret = deps.getWebhookSecret();
      if (!stripe || !webhookSecret) {
        return reply.status(503).send({ error: 'Billing is not configured on this server.', errorCode: 'BILLING_NOT_CONFIGURED' });
      }

      const signature = request.headers['stripe-signature'];
      if (!signature || typeof signature !== 'string') {
        return reply.status(400).send({ error: 'Missing Stripe-Signature header.' });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(request.body as Buffer, signature, webhookSecret);
      } catch (error) {
        request.log.warn(error, 'Stripe webhook signature verification failed');
        return reply.status(400).send({ error: 'Invalid webhook signature.' });
      }

      const isNew = await deps.eventRepo.markProcessed(event.id, event.type);
      if (isNew) {
        await handleStripeWebhookEvent(event, deps);
      }
      return reply.status(200).send({ received: true });
    });
  });
}
