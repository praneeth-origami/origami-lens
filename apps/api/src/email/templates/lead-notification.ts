import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface LeadNotificationEmailData {
  name: string;
  email: string;
  company?: string;
  message?: string;
  domain?: string;
  scanId?: string;
  healthScore?: number;
  issueSummary?: string;
}

/** Internal (Origami-side) notification — sent to LEADS_NOTIFICATION_EMAIL, never to the lead themselves (see lead-service.ts). */
export function renderLeadNotificationEmail(data: LeadNotificationEmailData): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <p>A new "Talk to Origami" request was submitted${data.domain ? ` from a report on <strong>${escapeHtml(data.domain)}</strong>` : ''}.</p>
    ${emailMetadataRow({ label: 'Name', value: data.name })}
    ${emailMetadataRow({ label: 'Email', value: data.email })}
    ${data.company ? emailMetadataRow({ label: 'Company', value: data.company }) : ''}
    ${data.healthScore !== undefined ? emailMetadataRow({ label: 'Health Score', value: `${data.healthScore}/100` }) : ''}
    ${data.issueSummary ? emailMetadataRow({ label: 'Issues found', value: data.issueSummary }) : ''}
    ${data.scanId ? emailMetadataRow({ label: 'Scan', value: data.scanId }) : ''}
    ${data.message ? `<p><strong>Message:</strong></p><p>${escapeHtml(data.message)}</p>` : ''}
  `;

  const text = [
    `A new "Talk to Origami" request was submitted${data.domain ? ` from a report on ${data.domain}` : ''}.`,
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    data.company ? `Company: ${data.company}` : '',
    data.healthScore !== undefined ? `Health Score: ${data.healthScore}/100` : '',
    data.issueSummary ? `Issues found: ${data.issueSummary}` : '',
    data.scanId ? `Scan: ${data.scanId}` : '',
    data.message ? `Message:\n${data.message}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.leadSubmitted(data.name),
    html: renderEmailLayout({ previewText: `New lead: ${data.name}`, bodyHtml }),
    text,
  };
}
