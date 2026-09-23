import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Built and previewable, but NOT wired — stripe-webhook-service.ts's
 * StripeWebhookServiceDeps has no email/user context injected today (bare
 * Stripe customer-id strings, no `expand`, no userRepo/organizationRepo).
 * Wiring a real send means adding a new dependency to payment-critical,
 * event-driven billing code — out of scope for an email-template task per
 * the spec's own caution against touching billing architecture.
 */
export interface BillingSubscriptionStartedEmailData {
  plan: string;
  seatCount?: number;
  currentPeriodEnd?: string;
  webAppBaseUrl: string;
}

export function renderBillingSubscriptionStartedEmail(data: BillingSubscriptionStartedEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const periodLabel = data.currentPeriodEnd
    ? new Date(data.currentPeriodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : undefined;
  const metaRows = [
    emailMetadataRow({ label: 'Plan', value: data.plan }),
    data.seatCount !== undefined ? emailMetadataRow({ label: 'Seats', value: String(data.seatCount) }) : '',
    periodLabel ? emailMetadataRow({ label: 'Renews', value: periodLabel }) : '',
  ].join('');
  const bodyHtml = `
    <p>Your <strong>${data.plan}</strong> subscription is now active. Thanks for upgrading Origami Lens.</p>
    ${metaRows}
    ${emailButton({ href: billingUrl, label: 'View billing' })}
  `;

  const text = [
    `Your ${data.plan} subscription is now active. Thanks for upgrading Origami Lens.`,
    `Plan: ${data.plan}`,
    data.seatCount !== undefined ? `Seats: ${data.seatCount}` : '',
    periodLabel ? `Renews: ${periodLabel}` : '',
    `View billing: ${billingUrl}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingSubscriptionStarted(data.plan),
    html: renderEmailLayout({ previewText: `Your ${data.plan} subscription is active`, bodyHtml }),
    text,
  };
}
