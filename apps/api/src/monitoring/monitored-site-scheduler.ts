/**
 * The DAILY monitoring scheduler — a plain `setInterval(...).unref()` sweep
 * registered in index.ts, the SAME shape as subscription-expiry-sweep.ts
 * and the repository-fix-workflow cleanup sweep (see their own doc
 * comments for why: nothing pushes a "this site is due for a re-scan"
 * event, so polling is correct here, same as it is for them). No new cron
 * library, no BullMQ repeatable jobs — this codebase's one established
 * precedent for "runs periodically with no request to trigger it."
 *
 * Idempotency/safety across overlapping ticks and worker restarts comes
 * entirely from MonitoredSiteRepository.claimDueSites' own atomic
 * UPDATE...RETURNING (see its doc comment) — a site is never claimed twice,
 * and a long-running or crashed scan never blocks it from eventually being
 * reclaimed on its next natural due date.
 */
import type { UsageMetric } from '@origami/contracts';
import type { MonitoredSiteRepository } from '../db/monitored-site-repository.js';
import type { MonitoredSiteService } from './monitored-site-service.js';

export interface MonitoredSiteSchedulerDeps {
  monitoredSiteRepo: Pick<MonitoredSiteRepository, 'claimDueSites'>;
  monitoredSiteService: Pick<MonitoredSiteService, 'triggerScan'>;
  entitlementService: { checkAndConsumeQuota(organizationId: string, metric: UsageMetric): Promise<{ allowed: boolean }> };
  batchSize?: number;
}

export interface SweepResult {
  attempted: number;
  skipped: number;
  failed: number;
}

export async function sweepDueMonitoredSites(deps: MonitoredSiteSchedulerDeps): Promise<SweepResult> {
  const dueSites = await deps.monitoredSiteRepo.claimDueSites(deps.batchSize ?? 25);
  let skipped = 0;
  let failed = 0;

  for (const site of dueSites) {
    try {
      // Scheduled scans consume the SAME daily INSPECTION quota a manual
      // scan would (checked via HTTP middleware for the manual path) — the
      // scheduler has no HTTP request to hang that middleware off of, so it
      // calls the same entitlement check directly instead of bypassing it.
      const quota = await deps.entitlementService.checkAndConsumeQuota(site.organizationId, 'INSPECTION');
      if (!quota.allowed) {
        skipped++;
        console.warn(`[monitoring-scheduler] skipped monitored site ${site.id} — INSPECTION quota exceeded for organization ${site.organizationId}`);
        continue;
      }
      await deps.monitoredSiteService.triggerScan(site, undefined);
    } catch (error) {
      failed++;
      console.error(`[monitoring-scheduler] failed to trigger a scan for monitored site ${site.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return { attempted: dueSites.length, skipped, failed };
}
