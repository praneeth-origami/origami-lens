import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Built and previewable, but NOT wired — there is no existing per-event
 * trigger point for this today. usage-limit-middleware.ts's 402 response
 * fires on every blocked request, which is the wrong place to send a
 * one-time email (it would send once per blocked request rather than once
 * per limit-reached event) without new debounce/rate-limit logic that
 * doesn't exist — out of scope for an email-template task.
 */
export interface BillingPlanLimitReachedEmailData {
  plan: string;
  resource?: string;
  resetAt?: string;
  webAppBaseUrl: string;
}

export function renderBillingPlanLimitReachedEmail(data: BillingPlanLimitReachedEmailData): { subject: string; html: string; text: string } {
  const billingUrl = `${data.webAppBaseUrl}/billing`;
  const resetLabel = data.resetAt ? new Date(data.resetAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
  const metaRows = [
    emailMetadataRow({ label: 'Plan', value: data.plan }),
    data.resource ? emailMetadataRow({ label: 'Limit reached', value: data.resource }) : '',
    resetLabel ? emailMetadataRow({ label: 'Resets', value: resetLabel }) : '',
  ].join('');
  const bodyHtml = `
    <p>You've reached your <strong>${data.plan}</strong> plan's usage limit.</p>
    ${metaRows}
    ${emailButton({ href: billingUrl, label: 'View plans' })}
  `;

  const text = [
    `You've reached your ${data.plan} plan's usage limit.`,
    data.resource ? `Limit reached: ${data.resource}` : '',
    resetLabel ? `Resets: ${resetLabel}` : '',
    `View plans: ${billingUrl}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.billingPlanLimitReached,
    html: renderEmailLayout({ previewText: "You've reached your plan limit", bodyHtml }),
    text,
  };
}
