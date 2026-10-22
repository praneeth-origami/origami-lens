/**
 * "Why did my website score drop?" orchestration (V3) — loads the
 * already-detected regression events and the two scans' already-computed
 * HealthScores, builds bounded context, and calls the AI provider. The AI
 * is NEVER asked to decide whether a regression exists: the deterministic
 * regression engine (regression-engine.ts, run from
 * monitoring-scan-completion.ts right after each scan) already decided
 * that; this only explains what it already found.
 */
import type { MonitoredSite, MonitoringAskErrorCode, MonitoringAskResponse, ScanResponse } from '@origami/contracts';
import { buildMonitoringAskContext } from './monitoring-ask-context.js';
import { MonitoringAskProviderError, type MonitoringAskProvider } from './monitoring-ask-provider.js';
import type { MonitoredSiteRepository } from '../db/monitored-site-repository.js';
import type { MonitoringEventRepository } from '../db/monitoring-event-repository.js';

export class MonitoringAskError extends Error {
  constructor(message: string, public readonly code: MonitoringAskErrorCode) {
    super(message);
    this.name = 'MonitoringAskError';
  }
}

export interface MonitoringAskStores {
  monitoredSiteRepo: Pick<MonitoredSiteRepository, 'getForOrganizations'>;
  eventRepo: Pick<MonitoringEventRepository, 'listForScan'>;
  getScan(scanId: string): Promise<ScanResponse | undefined>;
  getPreviousCompletedScanForMonitoredSite(monitoredSiteId: string, beforeScanId: string): Promise<ScanResponse | undefined>;
}

export interface MonitoringAskDeps {
  qaProvider: MonitoringAskProvider;
}

const DEFAULT_QUESTION = 'Why did my website score drop?';

export async function answerMonitoringQuestion(
  stores: MonitoringAskStores,
  monitoredSiteId: string,
  organizationIds: string[],
  question: unknown,
  deps: MonitoringAskDeps,
  signal?: AbortSignal,
): Promise<MonitoringAskResponse> {
  const validQuestion = typeof question === 'string' && question.trim() ? question : DEFAULT_QUESTION;

  const site: MonitoredSite | undefined = await stores.monitoredSiteRepo.getForOrganizations(monitoredSiteId, organizationIds);
  if (!site) throw new MonitoringAskError('Monitored website not found.', 'MONITORED_SITE_NOT_FOUND');
  if (!site.lastScanId) throw new MonitoringAskError('This website has not completed a scan yet.', 'NO_SCAN_DATA');

  const currentScan = await stores.getScan(site.lastScanId);
  if (!currentScan) throw new MonitoringAskError('No scan data is available for this website yet.', 'NO_SCAN_DATA');

  const [previousScan, events] = await Promise.all([
    stores.getPreviousCompletedScanForMonitoredSite(site.id, site.lastScanId),
    stores.eventRepo.listForScan(site.lastScanId),
  ]);

  const contextText = buildMonitoringAskContext({
    site: { name: site.name, url: site.url },
    currentHealthScore: currentScan.healthScore,
    previousHealthScore: previousScan?.healthScore,
    events,
    currentIssues: currentScan.issues,
  });

  let result: { answer: string };
  try {
    result = await deps.qaProvider.answer({ question: validQuestion, contextText }, signal);
  } catch (error) {
    if (error instanceof MonitoringAskProviderError) throw new MonitoringAskError(error.message, error.category);
    throw new MonitoringAskError('Monitoring Q&A failed unexpectedly.', 'ASK_FAILED');
  }

  return { answer: result.answer };
}
