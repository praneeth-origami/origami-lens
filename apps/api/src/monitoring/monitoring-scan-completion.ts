/**
 * Runs once, right after a monitoring scan reaches a terminal state (see
 * workers/website-scan-worker.ts's job handler) — marks the first-ever scan
 * as the baseline (no regression check), or runs the deterministic
 * regression engine against the previous scan and persists whatever
 * monitoring_events it produces. Never re-scores or re-scans anything
 * itself; every input here is data the existing scan pipeline already
 * computed and persisted.
 */
import type { MonitoringEvent, MonitoringSiteStatus, ScanArtifacts } from '@origami/contracts';
import type { ArtifactStore } from '../artifact-store.js';
import type { MonitoredSiteRepository } from '../db/monitored-site-repository.js';
import type { MonitoringEventRepository } from '../db/monitoring-event-repository.js';
import type { ScanRepository } from '../db/scan-repository.js';
import { compareConsoleErrors, compareHealthScore, compareNetworkErrors, compareVisualRegression } from './regression-engine.js';

export interface MonitoringScanCompletionDeps {
  scanRepo: Pick<ScanRepository, 'getScan' | 'getPreviousCompletedScanForMonitoredSite' | 'getRootPageScanData'>;
  monitoredSiteRepo: Pick<MonitoredSiteRepository, 'getById' | 'recordScanSuccess' | 'recordScanFailure'>;
  eventRepo: Pick<MonitoringEventRepository, 'createMany'>;
  artifactStore: Pick<ArtifactStore, 'readArtifactBase64'>;
  /** Email alert for an unattended regression — best-effort, never allowed to affect whether events are persisted (see the try/catch around its call below). Omitted in tests that don't care about notification delivery. */
  notifyRegression?(monitoredSiteId: string, scanId: string, events: MonitoringEvent[]): Promise<void>;
}

function hasDesktopScreenshot(artifacts?: ScanArtifacts): boolean {
  return artifacts?.screenshots.some((s) => s.viewport === 'desktop') ?? false;
}

export async function processMonitoringScanCompletion(monitoredSiteId: string, scanId: string, deps: MonitoringScanCompletionDeps): Promise<void> {
  const site = await deps.monitoredSiteRepo.getById(monitoredSiteId);
  if (!site) return; // The monitor was deleted while this scan was in flight — nothing left to update.

  const currentScan = await deps.scanRepo.getScan(scanId);
  if (!currentScan) return;

  if (currentScan.status === 'FAILED') {
    await deps.monitoredSiteRepo.recordScanFailure(monitoredSiteId, scanId, currentScan.error ?? 'Scan failed.');
    return;
  }

  // "Mark it as baseline. Do NOT generate a regression alert for the
  // baseline." (V3 spec §7) — the FIRST scan for a site is never compared
  // against anything.
  if (!site.baselineScanId) {
    await deps.monitoredSiteRepo.recordScanSuccess(monitoredSiteId, { scanId, scannedAt: currentScan.scannedAt, status: 'HEALTHY', setBaselineIfUnset: true });
    return;
  }

  const previousScan = await deps.scanRepo.getPreviousCompletedScanForMonitoredSite(monitoredSiteId, scanId);
  const drafts = [...compareHealthScore(previousScan?.healthScore, currentScan.healthScore)];

  const currentPage = await deps.scanRepo.getRootPageScanData(scanId);
  const previousPage = previousScan ? await deps.scanRepo.getRootPageScanData(previousScan.scanId) : undefined;
  const pageUrl = currentPage?.url ?? currentScan.url;

  if (currentPage?.fullEvidence) {
    drafts.push(...compareConsoleErrors(previousPage?.fullEvidence?.console, currentPage.fullEvidence.console, pageUrl));
    drafts.push(...compareNetworkErrors(previousPage?.fullEvidence?.network, currentPage.fullEvidence.network, pageUrl));
  }

  if (currentPage) {
    const visualEvent = await compareVisualRegression(
      deps.artifactStore,
      previousScan && previousPage
        ? { screenshotKey: `${previousScan.scanId}/${previousPage.pageScanId}`, hasDesktopScreenshot: hasDesktopScreenshot(previousPage.artifacts) }
        : undefined,
      { screenshotKey: `${scanId}/${currentPage.pageScanId}`, hasDesktopScreenshot: hasDesktopScreenshot(currentPage.artifacts) },
    );
    if (visualEvent) drafts.push(visualEvent);
  }

  const status: MonitoringSiteStatus = drafts.length > 0 ? 'REGRESSION' : 'HEALTHY';
  await deps.monitoredSiteRepo.recordScanSuccess(monitoredSiteId, { scanId, scannedAt: currentScan.scannedAt, status, setBaselineIfUnset: false });

  if (drafts.length === 0) return;

  const created = await deps.eventRepo.createMany(
    drafts.map((draft) => ({ monitoredSiteId, scanId, previousScanId: previousScan?.scanId, ...draft })),
  );

  if (deps.notifyRegression) {
    try {
      await deps.notifyRegression(monitoredSiteId, scanId, created);
    } catch (error) {
      console.error(`[monitoring] regression notification failed for site ${monitoredSiteId}:`, error instanceof Error ? error.message : error);
    }
  }
}
