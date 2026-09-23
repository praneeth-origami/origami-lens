import { renderEmailLayout } from '../layout.js';
import { emailButton, emailAlert } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/** Built and previewable, but NOT wired — see billing-subscription-started.ts's doc comment for why. */
export interface BillingPaymentFailedEmailData {
  plan?: string;
  webAppBaseUrl: string;
}

export function renderBillingPaymentFailedEmail(data: BillingPaymentFailedEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const bodyHtml = `
    <p>We couldn't process your latest payment${data.plan ? ` for your ${data.plan} plan` : ''}.</p>
    ${emailAlert({ tone: 'danger', message: 'Update your payment method to avoid losing access to paid features.' })}
    ${emailButton({ href: billingUrl, label: 'Update payment method' })}
  `;

  const text = [
    `We couldn't process your latest payment${data.plan ? ` for your ${data.plan} plan` : ''}.`,
    'Update your payment method to avoid losing access to paid features.',
    `Update it here: ${billingUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingPaymentFailed,
    html: renderEmailLayout({ previewText: 'Your payment failed', bodyHtml }),
    text,
  };
}
