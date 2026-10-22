import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HealthScore, MonitoredSite, MonitoringEvent, ScanResponse } from '@origami/contracts';
import { processMonitoringScanCompletion, type MonitoringScanCompletionDeps } from './monitoring-scan-completion.js';

function fakeHealthScore(overallScore: number): HealthScore {
  const base = { score: overallScore, weight: 100 / 7 };
  return {
    overallScore,
    categories: { functional: base, performance: base, visualMobile: base, accessibility: base, bestPractices: base, seo: base, securityHygiene: base },
  };
}

function fakeScan(overrides: Partial<ScanResponse> = {}): ScanResponse {
  return {
    scanId: 'scan-1',
    url: 'https://example.com',
    status: 'COMPLETED',
    healthScore: fakeHealthScore(90),
    issues: [],
    summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0 },
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeSite(overrides: Partial<MonitoredSite> = {}): MonitoredSite {
  return {
    id: 'site-1',
    organizationId: 'org-1',
    name: 'Checkout',
    url: 'https://example.com',
    enabled: true,
    frequency: 'DAILY',
    status: 'PENDING',
    nextScanAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface TestHarness {
  deps: MonitoringScanCompletionDeps;
  recordedSuccess: Array<{ id: string; status: string; setBaselineIfUnset: boolean }>;
  recordedFailure: Array<{ id: string; scanId: string; error: string }>;
  createdEvents: MonitoringEvent[];
  notifyCalls: Array<{ monitoredSiteId: string; scanId: string; events: MonitoringEvent[] }>;
}

function harness(site: MonitoredSite, scans: Record<string, ScanResponse>, previousScanId?: string): TestHarness {
  const recordedSuccess: TestHarness['recordedSuccess'] = [];
  const recordedFailure: TestHarness['recordedFailure'] = [];
  const createdEvents: MonitoringEvent[] = [];
  const notifyCalls: TestHarness['notifyCalls'] = [];

  const deps: MonitoringScanCompletionDeps = {
    scanRepo: {
      async getScan(scanId) { return scans[scanId]; },
      async getPreviousCompletedScanForMonitoredSite() { return previousScanId ? scans[previousScanId] : undefined; },
      async getRootPageScanData() { return undefined; }, // no console/network/visual evidence in these tests — regression-engine.test.ts covers those directly
    },
    monitoredSiteRepo: {
      async getById() { return site; },
      async recordScanSuccess(id, params) {
        recordedSuccess.push({ id, status: params.status, setBaselineIfUnset: params.setBaselineIfUnset });
      },
      async recordScanFailure(id, scanId, error) {
        recordedFailure.push({ id, scanId, error });
      },
    },
    eventRepo: {
      async createMany(events) {
        const created = events.map((e, i) => ({ id: `event-${i}`, createdAt: new Date().toISOString(), metadata: e.metadata ?? {}, ...e }) as MonitoringEvent);
        createdEvents.push(...created);
        return created;
      },
    },
    artifactStore: { readArtifactBase64: () => undefined },
    async notifyRegression(monitoredSiteId, scanId, events) {
      notifyCalls.push({ monitoredSiteId, scanId, events });
    },
  };

  return { deps, recordedSuccess, recordedFailure, createdEvents, notifyCalls };
}

describe('processMonitoringScanCompletion', () => {
  it('marks the FIRST scan as baseline and creates NO regression event', async () => {
    const site = fakeSite({ baselineScanId: undefined });
    const scan = fakeScan({ scanId: 'scan-1', healthScore: fakeHealthScore(91) });
    const { deps, recordedSuccess, createdEvents, notifyCalls } = harness(site, { 'scan-1': scan });

    await processMonitoringScanCompletion(site.id, 'scan-1', deps);

    assert.equal(recordedSuccess.length, 1);
    assert.equal(recordedSuccess[0].setBaselineIfUnset, true);
    assert.equal(recordedSuccess[0].status, 'HEALTHY');
    assert.equal(createdEvents.length, 0);
    assert.equal(notifyCalls.length, 0);
  });

  it('a second scan with an unchanged Health Score produces NO false regression', async () => {
    const site = fakeSite({ baselineScanId: 'scan-1' });
    const previous = fakeScan({ scanId: 'scan-1', healthScore: fakeHealthScore(91) });
    const current = fakeScan({ scanId: 'scan-2', healthScore: fakeHealthScore(91) });
    const { deps, recordedSuccess, createdEvents, notifyCalls } = harness(site, { 'scan-1': previous, 'scan-2': current }, 'scan-1');

    await processMonitoringScanCompletion(site.id, 'scan-2', deps);

    assert.equal(recordedSuccess[0].status, 'HEALTHY');
    assert.equal(createdEvents.length, 0);
    assert.equal(notifyCalls.length, 0);
  });

  it('a major Health Score drop creates a HEALTH_SCORE_DROP event, marks the site REGRESSION, and sends a notification', async () => {
    const site = fakeSite({ baselineScanId: 'scan-1' });
    const previous = fakeScan({ scanId: 'scan-1', healthScore: fakeHealthScore(91) });
    const current = fakeScan({ scanId: 'scan-2', healthScore: fakeHealthScore(67) });
    const { deps, recordedSuccess, createdEvents, notifyCalls } = harness(site, { 'scan-1': previous, 'scan-2': current }, 'scan-1');

    await processMonitoringScanCompletion(site.id, 'scan-2', deps);

    assert.equal(recordedSuccess[0].status, 'REGRESSION');
    assert.ok(createdEvents.some((e) => e.eventType === 'HEALTH_SCORE_DROP'));
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].events.length, createdEvents.length);
  });

  it('a FAILED scan records the failure and never runs the regression comparison', async () => {
    const site = fakeSite({ baselineScanId: 'scan-1' });
    const failedScan = fakeScan({ scanId: 'scan-2', status: 'FAILED', error: 'All pages failed to scan' });
    const { deps, recordedFailure, recordedSuccess, createdEvents } = harness(site, { 'scan-2': failedScan });

    await processMonitoringScanCompletion(site.id, 'scan-2', deps);

    assert.equal(recordedFailure.length, 1);
    assert.equal(recordedFailure[0].error, 'All pages failed to scan');
    assert.equal(recordedSuccess.length, 0);
    assert.equal(createdEvents.length, 0);
  });

  it('a notification failure never prevents the events from having been persisted', async () => {
    const site = fakeSite({ baselineScanId: 'scan-1' });
    const previous = fakeScan({ scanId: 'scan-1', healthScore: fakeHealthScore(91) });
    const current = fakeScan({ scanId: 'scan-2', healthScore: fakeHealthScore(60) });
    const { deps, createdEvents } = harness(site, { 'scan-1': previous, 'scan-2': current }, 'scan-1');
    deps.notifyRegression = async () => { throw new Error('SMTP down'); };

    await processMonitoringScanCompletion(site.id, 'scan-2', deps);

    assert.ok(createdEvents.length > 0); // the events were still created even though notification failed
  });
});
