import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow, emailAlert } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Sent once per billing period, a few days before a subscription that is
 * set to CANCEL at period end actually lapses — distinct from
 * billing-subscription-cancelled.ts, which fires only after Stripe confirms
 * the subscription has already ended. See subscription-expiry-sweep.ts for
 * the trigger (a scheduled sweep, not a Stripe webhook — Stripe pushes no
 * event for "N days until a regular subscription's period ends").
 */
export interface BillingPlanExpiringSoonEmailData {
  plan: string;
  currentPeriodEnd: string;
  webAppBaseUrl: string;
}

export function renderBillingPlanExpiringSoonEmail(data: BillingPlanExpiringSoonEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const endsLabel = new Date(data.currentPeriodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const bodyHtml = `
    <p>Your <strong>${data.plan}</strong> plan is set to end soon.</p>
    ${emailMetadataRow({ label: 'Ends', value: endsLabel })}
    ${emailAlert({ tone: 'warning', message: "You'll move to the Free plan on that date unless you resubscribe before then." })}
    ${emailButton({ href: billingUrl, label: 'Manage subscription' })}
  `;

  const text = [
    `Your ${data.plan} plan is set to end soon.`,
    `Ends: ${endsLabel}`,
    "You'll move to the Free plan on that date unless you resubscribe before then.",
    `Manage your subscription: ${billingUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingPlanExpiringSoon(data.plan),
    html: renderEmailLayout({ previewText: `Your ${data.plan} plan ends on ${endsLabel}`, bodyHtml }),
    text,
  };
}
