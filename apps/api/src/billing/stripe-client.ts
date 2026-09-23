/**
 * Lazy Stripe client — mirrors email-service.ts's isEmailConfigured()/
 * getSmtpConfig() pattern exactly: no keys configured is a normal, expected
 * state (this repo's dev environment has none yet), never a crash. Every
 * billing route/service checks getStripeClient() for null and responds with
 * BILLING_NOT_CONFIGURED rather than assuming Stripe is reachable.
 */
import Stripe from 'stripe';

let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** Mirrors db/pool.ts's getPool() exactly: re-checks the env var on every call (unset -> null, no stale cache), only caching the constructed instance once a key is present. */
export function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Stripe(key);
  return client;
}

export function getStripeWebhookSecret(): string | undefined {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
}
