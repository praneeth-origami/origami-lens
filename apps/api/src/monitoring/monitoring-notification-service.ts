/**
 * Alerts a user about a monitoring regression that happened while nobody
 * was watching — email only. The custom in-app Lens notification system
 * (apps/web/src/notifications/lens-event.ts) is purely client-side/
 * ephemeral (confirmed: no websocket/SSE/persisted-notification mechanism
 * exists anywhere in this codebase — see the V3 audit), so it cannot alert
 * an away user; it's used instead for the Run Now button's own immediate,
 * in-tab feedback (apps/web/src/components, wired separately from this
 * file). Deliberately NEVER sends an "all clear" email for a routine,
 * no-regression scheduled scan — that would be noise on every
 * monitored site, every day, for the common case.
 */
import { MonitoredSiteRepository } from '../db/monitored-site-repository.js';
import { OrganizationRepository } from '../db/organization-repository.js';
import { sendMonitoringRegressionDetectedEmail } from '../email-service.js';
import type { MonitoringEvent } from '@origami/contracts';

const monitoredSiteRepo = new MonitoredSiteRepository();
const organizationRepo = new OrganizationRepository();

export async function sendMonitoringRegressionNotification(monitoredSiteId: string, _scanId: string, events: MonitoringEvent[]): Promise<void> {
  if (events.length === 0) return;
  // Same default/trim convention as index.ts's own WEB_APP_BASE_URL constant.
  const webAppBaseUrl = (process.env.WEB_APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');

  const site = await monitoredSiteRepo.getById(monitoredSiteId);
  if (!site) return;

  const members = await organizationRepo.listMembers(site.organizationId);
  const owner = members.find((member) => member.role === 'OWNER');
  if (!owner?.email) return;

  await sendMonitoringRegressionDetectedEmail(owner.email, {
    siteName: site.name,
    siteUrl: site.url,
    eventTitles: events.map((e) => e.title),
    webAppBaseUrl,
    monitoredSiteId: site.id,
  });
}
