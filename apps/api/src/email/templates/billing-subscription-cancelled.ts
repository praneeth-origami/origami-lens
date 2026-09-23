import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/** Built and previewable, but NOT wired — see billing-subscription-started.ts's doc comment for why. */
export interface BillingSubscriptionCancelledEmailData {
  plan: string;
  effectiveAt?: string;
  webAppBaseUrl: string;
}

export function renderBillingSubscriptionCancelledEmail(data: BillingSubscriptionCancelledEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const effectiveLabel = data.effectiveAt
    ? new Date(data.effectiveAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : undefined;
  const bodyHtml = `
    <p>Your <strong>${data.plan}</strong> subscription has been cancelled.</p>
    ${effectiveLabel ? emailMetadataRow({ label: 'Access ends', value: effectiveLabel }) : ''}
    <p style="color:#667085;font-size:13px;">You can resubscribe at any time.</p>
    ${emailButton({ href: billingUrl, label: 'View plans' })}
  `;

  const text = [
    `Your ${data.plan} subscription has been cancelled.`,
    effectiveLabel ? `Access ends: ${effectiveLabel}` : '',
    'You can resubscribe at any time.',
    `View plans: ${billingUrl}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingSubscriptionCancelled,
    html: renderEmailLayout({ previewText: 'Your subscription was cancelled', bodyHtml }),
    text,
  };
}
