import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow, emailAlert } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Continuous Monitoring (V3) — the ONLY automated monitoring email: sent
 * when a scheduled or manually-triggered scan's deterministic regression
 * engine (monitoring/regression-engine.ts) finds at least one regression
 * event. Deliberately NOT sent for a routine "no regression" scan — see
 * monitoring-notification-service.ts's doc comment on why an "all clear"
 * email would be noise, not signal, for a daily check.
 */
export interface MonitoringRegressionDetectedEmailData {
  siteName: string;
  siteUrl: string;
  eventTitles: string[];
  webAppBaseUrl: string;
  monitoredSiteId: string;
}

export function renderMonitoringRegressionDetectedEmail(data: MonitoringRegressionDetectedEmailData): { subject: string; html: string; text: string } {
  const detailUrl = `${data.webAppBaseUrl}/monitoring/${data.monitoredSiteId}`;
  const listHtml = data.eventTitles.map((title) => `<li>${title}</li>`).join('');

  const bodyHtml = `
    <p>Continuous monitoring detected a regression on <strong>${data.siteName}</strong>.</p>
    ${emailMetadataRow({ label: 'Website', value: data.siteUrl })}
    ${emailAlert({ tone: 'warning', message: 'Regression detected' })}
    <ul>${listHtml}</ul>
    ${emailButton({ href: detailUrl, label: 'View Changes' })}
  `;

  const text = [
    `Continuous monitoring detected a regression on ${data.siteName} (${data.siteUrl}).`,
    'Regression detected:',
    ...data.eventTitles.map((title) => `- ${title}`),
    `View changes: ${detailUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.monitoringRegressionDetected(data.siteName),
    html: renderEmailLayout({ previewText: `Regression detected on ${data.siteName}`, bodyHtml }),
    text,
  };
}
