/**
 * Monitored-site CRUD + lifecycle (create, pause/resume, manual "Run Now",
 * list/detail reads) — the configuration layer on top of the existing scan
 * pipeline. This file never runs a scan itself; it only creates the scan
 * ROW (createWebsiteScanRecord) and enqueues it (enqueueWebsiteScan), the
 * exact same two calls an ordinary manual website scan uses. What happens
 * AFTER a monitoring scan completes (baseline marking, regression
 * comparison, events, notification) lives in monitoring-scan-completion.ts,
 * run from the worker's own completion hook — not from here.
 */
import { randomUUID } from 'node:crypto';
import type {
  CreateMonitoredSiteRequest,
  ListMonitoredSitesResponse,
  MonitoredSite,
  MonitoredSiteDetail,
  MonitoredSiteErrorCode,
  MonitoredSiteScanHistoryEntry,
  MonitoredSiteSummary,
  ScanResponse,
  UpdateMonitoredSiteRequest,
  WebsiteScanOptions,
} from '@origami/contracts';
import { assertSafeMonitoringUrl, UrlSafetyError } from '../url-safety.js';
import type { MonitoredSiteRepository } from '../db/monitored-site-repository.js';
import type { MonitoringEventRepository } from '../db/monitoring-event-repository.js';

export class MonitoredSiteError extends Error {
  constructor(message: string, public readonly code: MonitoredSiteErrorCode) {
    super(message);
    this.name = 'MonitoredSiteError';
  }
}

export interface MonitoredSiteScanRepo {
  getScan(scanId: string): Promise<ScanResponse | undefined>;
  listScansForMonitoredSite(monitoredSiteId: string, limit?: number): Promise<ScanResponse[]>;
  hasActiveScanForMonitoredSite(monitoredSiteId: string): Promise<boolean>;
}

export interface MonitoredSiteEntitlementService {
  canCreateMonitoredSite(organizationId: string, currentEnabledCount: number): Promise<{ allowed: boolean; limit: number | null }>;
}

export interface MonitoredSiteServiceDeps {
  monitoredSiteRepo: MonitoredSiteRepository;
  scanRepo: MonitoredSiteScanRepo;
  eventRepo: Pick<MonitoringEventRepository, 'listForMonitoredSite'>;
  entitlementService: MonitoredSiteEntitlementService;
  createWebsiteScanRecord(rootUrl: string, options: WebsiteScanOptions, ownerId: string | undefined, organizationId: string, monitoredSiteId: string): Promise<string>;
  enqueueWebsiteScan(scanId: string, rootUrl: string, options: WebsiteScanOptions, ownerId: string | undefined, monitoredSiteId: string): Promise<boolean>;
}

/** Monitoring scans always capture a desktop screenshot (needed for visual regression) and run axe (needed for the accessibility category) — a deliberate, fixed option set, not user-configurable in V3, so every monitoring scan of the same site is apples-to-apples comparable. */
const MONITORING_SCAN_OPTIONS: WebsiteScanOptions = {
  discoveryMethod: 'AUTOMATIC',
  maxPages: 1,
  includeScreenshots: true,
  mobileViewport: false,
  runLighthouse: true,
  runAxe: true,
};

export class MonitoredSiteService {
  constructor(private readonly deps: MonitoredSiteServiceDeps) {}

  async create(userId: string, organizationId: string, request: CreateMonitoredSiteRequest): Promise<MonitoredSite> {
    const name = request.name?.trim();
    if (!name) throw new MonitoredSiteError('A website name is required.', 'MONITORED_SITE_INVALID');

    let safeUrl: URL;
    try {
      safeUrl = await assertSafeMonitoringUrl(request.url);
    } catch (error) {
      if (error instanceof UrlSafetyError) throw new MonitoredSiteError(error.message, 'MONITORED_SITE_URL_UNSAFE');
      throw error;
    }

    const currentCount = await this.deps.monitoredSiteRepo.countEnabledForOrganization(organizationId);
    const entitlement = await this.deps.entitlementService.canCreateMonitoredSite(organizationId, currentCount);
    if (!entitlement.allowed) {
      throw new MonitoredSiteError(
        entitlement.limit === 0
          ? 'Continuous monitoring is not included on your current plan.'
          : `You've reached your plan's limit of ${entitlement.limit} monitored website${entitlement.limit === 1 ? '' : 's'}.`,
        'MONITORED_SITE_LIMIT_REACHED',
      );
    }

    const site = await this.deps.monitoredSiteRepo.create({
      id: randomUUID(),
      organizationId,
      name,
      url: safeUrl.toString(),
      frequency: request.frequency ?? 'DAILY',
      enabled: request.enabled ?? true,
      createdByUserId: userId,
      nextScanAt: new Date().toISOString(),
    });

    // "Schedule first monitoring scan" (V3 spec §7) — triggered immediately
    // rather than waiting for the next scheduler sweep tick, so a user who
    // just added a website sees it start scanning right away.
    if (site.enabled) {
      await this.triggerScan(site, userId);
    }

    return site;
  }

  async getForOrganizations(id: string, organizationIds: string[]): Promise<MonitoredSite | undefined> {
    return this.deps.monitoredSiteRepo.getForOrganizations(id, organizationIds);
  }

  async listSummariesForOrganizations(organizationIds: string[]): Promise<ListMonitoredSitesResponse> {
    const sites = await this.deps.monitoredSiteRepo.listForOrganizations(organizationIds);
    const summaries: MonitoredSiteSummary[] = [];
    let healthy = 0, regressions = 0, failed = 0, paused = 0;

    for (const site of sites) {
      if (!site.enabled) paused++;
      else if (site.status === 'REGRESSION') regressions++;
      else if (site.status === 'FAILED') failed++;
      else if (site.status === 'HEALTHY') healthy++;

      const [currentScan, previousScan, openEvents] = await Promise.all([
        site.lastScanId ? this.deps.scanRepo.getScan(site.lastScanId) : Promise.resolve(undefined),
        this.getPreviousScan(site),
        this.deps.eventRepo.listForMonitoredSite(site.id, 10),
      ]);

      summaries.push({
        ...site,
        currentHealthScore: currentScan?.healthScore?.overallScore,
        previousHealthScore: previousScan?.healthScore?.overallScore,
        openRegressionCount: site.lastScanId ? openEvents.filter((e) => e.scanId === site.lastScanId).length : 0,
      });
    }

    return { sites: summaries, stats: { total: sites.length, healthy, regressions, failed, paused } };
  }

  async getDetailForOrganizations(id: string, organizationIds: string[]): Promise<MonitoredSiteDetail | undefined> {
    const site = await this.deps.monitoredSiteRepo.getForOrganizations(id, organizationIds);
    if (!site) return undefined;

    const [scans, events, baselineScan] = await Promise.all([
      this.deps.scanRepo.listScansForMonitoredSite(site.id, 30),
      this.deps.eventRepo.listForMonitoredSite(site.id, 50),
      site.baselineScanId ? this.deps.scanRepo.getScan(site.baselineScanId) : Promise.resolve(undefined),
    ]);

    const scanHistory: MonitoredSiteScanHistoryEntry[] = scans.map((scan) => ({
      scanId: scan.scanId,
      scannedAt: scan.scannedAt,
      status: scan.status ?? 'COMPLETED',
      healthScore: scan.healthScore?.overallScore,
      hasOpenRegression: events.some((e) => e.scanId === scan.scanId),
    }));

    const currentScan = scans[0];
    const previousScan = scans[1];

    return {
      site,
      currentHealthScore: currentScan?.healthScore?.overallScore,
      previousHealthScore: previousScan?.healthScore?.overallScore,
      baselineHealthScore: baselineScan?.healthScore?.overallScore,
      scanHistory,
      events,
    };
  }

  async update(id: string, organizationIds: string[], patch: UpdateMonitoredSiteRequest): Promise<MonitoredSite> {
    const site = await this.requireOwned(id, organizationIds);
    const updated = await this.deps.monitoredSiteRepo.updateConfig(site.id, patch);
    if (!updated) throw new MonitoredSiteError('Monitored website not found.', 'MONITORED_SITE_NOT_FOUND');
    return updated;
  }

  async pause(id: string, organizationIds: string[]): Promise<MonitoredSite> {
    const site = await this.requireOwned(id, organizationIds);
    const updated = await this.deps.monitoredSiteRepo.setEnabled(site.id, false);
    if (!updated) throw new MonitoredSiteError('Monitored website not found.', 'MONITORED_SITE_NOT_FOUND');
    return updated;
  }

  async resume(id: string, organizationIds: string[]): Promise<MonitoredSite> {
    const site = await this.requireOwned(id, organizationIds);
    // Resuming schedules the next scan right away rather than waiting out
    // whatever next_scan_at was frozen at while paused.
    const updated = await this.deps.monitoredSiteRepo.setEnabled(site.id, true, new Date().toISOString());
    if (!updated) throw new MonitoredSiteError('Monitored website not found.', 'MONITORED_SITE_NOT_FOUND');
    return updated;
  }

  async delete(id: string, organizationIds: string[]): Promise<void> {
    const site = await this.requireOwned(id, organizationIds);
    await this.deps.monitoredSiteRepo.delete(site.id);
  }

  /** Manual "Run Now" — same scan engine, same entitlement quota, same duplicate-run guard as the scheduler's own trigger path (see triggerScan). */
  async runNow(id: string, organizationIds: string[], userId: string): Promise<{ scanId: string }> {
    const site = await this.requireOwned(id, organizationIds);
    const scanId = await this.triggerScan(site, userId);
    return { scanId };
  }

  private async getPreviousScan(site: MonitoredSite): Promise<ScanResponse | undefined> {
    const scans = await this.deps.scanRepo.listScansForMonitoredSite(site.id, 2);
    return scans[1];
  }

  private async requireOwned(id: string, organizationIds: string[]): Promise<MonitoredSite> {
    const site = await this.deps.monitoredSiteRepo.getForOrganizations(id, organizationIds);
    if (!site) throw new MonitoredSiteError('Monitored website not found.', 'MONITORED_SITE_NOT_FOUND');
    return site;
  }

  /** Shared by create()'s first scan, manual Run Now, and (via monitored-site-scheduler.ts calling this same service) the scheduled daily sweep — there is exactly one code path that starts a monitoring scan. */
  async triggerScan(site: MonitoredSite, userId: string | undefined): Promise<string> {
    if (await this.deps.scanRepo.hasActiveScanForMonitoredSite(site.id)) {
      throw new MonitoredSiteError('A scan is already running for this website.', 'MONITORED_SITE_SCAN_IN_PROGRESS');
    }

    // Re-validated here (not just at creation) — DNS can be repointed after
    // a site is saved; see url-safety.ts's own doc comment on this exact risk.
    try {
      await assertSafeMonitoringUrl(site.url);
    } catch (error) {
      if (error instanceof UrlSafetyError) throw new MonitoredSiteError(error.message, 'MONITORED_SITE_URL_UNSAFE');
      throw error;
    }

    const scanId = await this.deps.createWebsiteScanRecord(site.url, MONITORING_SCAN_OPTIONS, userId, site.organizationId, site.id);
    const enqueued = await this.deps.enqueueWebsiteScan(scanId, site.url, MONITORING_SCAN_OPTIONS, userId, site.id);
    if (!enqueued) throw new MonitoredSiteError('Website monitoring requires the scan queue to be configured.', 'MONITORED_SITE_INVALID');

    await this.deps.monitoredSiteRepo.recordScanQueued(site.id, scanId);
    return scanId;
  }
}
