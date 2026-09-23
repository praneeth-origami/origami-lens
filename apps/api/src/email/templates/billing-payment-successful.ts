import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/** Built and previewable, but NOT wired — see billing-subscription-started.ts's doc comment for why. */
export interface BillingPaymentSuccessfulEmailData {
  amount?: string;
  plan?: string;
  webAppBaseUrl: string;
}

export function renderBillingPaymentSuccessfulEmail(data: BillingPaymentSuccessfulEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const metaRows = [
    data.amount ? emailMetadataRow({ label: 'Amount', value: data.amount }) : '',
    data.plan ? emailMetadataRow({ label: 'Plan', value: data.plan }) : '',
  ].join('');
  const bodyHtml = `
    <p>We've received your payment for Origami Lens. Thanks!</p>
    ${metaRows}
    ${emailButton({ href: billingUrl, label: 'View billing' })}
  `;

  const text = [
    "We've received your payment for Origami Lens. Thanks!",
    data.amount ? `Amount: ${data.amount}` : '',
    data.plan ? `Plan: ${data.plan}` : '',
    `View billing: ${billingUrl}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingPaymentSuccessful,
    html: renderEmailLayout({ previewText: 'Your payment was successful', bodyHtml }),
    text,
  };
}
