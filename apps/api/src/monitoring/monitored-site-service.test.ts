import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MonitoredSite } from '@origami/contracts';
import { MonitoredSiteError, MonitoredSiteService, type MonitoredSiteServiceDeps } from './monitored-site-service.js';

function fakeSite(overrides: Partial<MonitoredSite> = {}): MonitoredSite {
  return {
    id: 'site-1',
    organizationId: 'org-1',
    name: 'Checkout',
    url: 'https://example.com/checkout',
    enabled: true,
    frequency: 'DAILY',
    status: 'PENDING',
    nextScanAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<{
  sites: Map<string, MonitoredSite>;
  activeScans: Set<string>;
  enabledCount: number;
  entitlementAllowed: boolean;
  enqueueSucceeds: boolean;
}> = {}) {
  const sites = overrides.sites ?? new Map<string, MonitoredSite>();
  const activeScans = overrides.activeScans ?? new Set<string>();
  const createdScanIds: string[] = [];
  const enqueuedCalls: Array<{ scanId: string; rootUrl: string; monitoredSiteId: string }> = [];
  const queuedSites: string[] = [];

  const deps: MonitoredSiteServiceDeps = {
    monitoredSiteRepo: {
      async create(input) {
        const site = fakeSite({ id: input.id, organizationId: input.organizationId, name: input.name, url: input.url, enabled: input.enabled, frequency: input.frequency, nextScanAt: input.nextScanAt });
        sites.set(site.id, site);
        return site;
      },
      async getForOrganizations(id, organizationIds) {
        const site = sites.get(id);
        if (!site || !organizationIds.includes(site.organizationId)) return undefined;
        return site;
      },
      async listForOrganizations(organizationIds) {
        return [...sites.values()].filter((s) => organizationIds.includes(s.organizationId));
      },
      async countEnabledForOrganization() {
        return overrides.enabledCount ?? 0;
      },
      async updateConfig(id, patch) {
        const site = sites.get(id);
        if (!site) return undefined;
        const updated = { ...site, ...patch };
        sites.set(id, updated);
        return updated;
      },
      async setEnabled(id, enabled, nextScanAt) {
        const site = sites.get(id);
        if (!site) return undefined;
        const updated = { ...site, enabled, nextScanAt: nextScanAt ?? site.nextScanAt };
        sites.set(id, updated);
        return updated;
      },
      async delete(id) {
        return sites.delete(id);
      },
      async recordScanQueued(id, scanId) {
        queuedSites.push(id);
        const site = sites.get(id);
        if (site) sites.set(id, { ...site, lastScanId: scanId });
      },
    } as unknown as MonitoredSiteServiceDeps['monitoredSiteRepo'],
    scanRepo: {
      async getScan() { return undefined; },
      async listScansForMonitoredSite() { return []; },
      async hasActiveScanForMonitoredSite(id) { return activeScans.has(id); },
    },
    eventRepo: {
      async listForMonitoredSite() { return []; },
    },
    entitlementService: {
      async canCreateMonitoredSite() { return { allowed: overrides.entitlementAllowed ?? true, limit: null }; },
    },
    async createWebsiteScanRecord(_rootUrl, _options, _ownerId, _organizationId, monitoredSiteId) {
      const scanId = `scan-${createdScanIds.length + 1}`;
      createdScanIds.push(scanId);
      if (monitoredSiteId) activeScans.add(monitoredSiteId);
      return scanId;
    },
    async enqueueWebsiteScan(scanId, rootUrl, _options, _ownerId, monitoredSiteId) {
      enqueuedCalls.push({ scanId, rootUrl, monitoredSiteId: monitoredSiteId ?? '' });
      return overrides.enqueueSucceeds ?? true;
    },
  };

  return { deps, sites, activeScans, createdScanIds, enqueuedCalls, queuedSites };
}

describe('MonitoredSiteService.create', () => {
  it('rejects a private/internal URL (SSRF protection)', async () => {
    const { deps } = fakeDeps();
    const service = new MonitoredSiteService(deps);
    await assert.rejects(
      () => service.create('user-1', 'org-1', { name: 'Internal', url: 'http://127.0.0.1:8080/admin' }),
      (error: unknown) => { assert.ok(error instanceof MonitoredSiteError); assert.equal(error.code, 'MONITORED_SITE_URL_UNSAFE'); return true; },
    );
  });

  it('rejects when the plan does not include continuous monitoring capacity', async () => {
    const { deps } = fakeDeps({ entitlementAllowed: false });
    const service = new MonitoredSiteService(deps);
    await assert.rejects(
      () => service.create('user-1', 'org-1', { name: 'Checkout', url: 'https://example.com' }),
      (error: unknown) => { assert.ok(error instanceof MonitoredSiteError); assert.equal(error.code, 'MONITORED_SITE_LIMIT_REACHED'); return true; },
    );
  });

  it('creates the site and immediately triggers the first (baseline) scan', async () => {
    const { deps, enqueuedCalls, queuedSites } = fakeDeps();
    const service = new MonitoredSiteService(deps);
    const site = await service.create('user-1', 'org-1', { name: 'Checkout', url: 'https://example.com/checkout' });
    assert.equal(site.name, 'Checkout');
    assert.equal(enqueuedCalls.length, 1);
    assert.equal(enqueuedCalls[0].monitoredSiteId, site.id);
    assert.equal(queuedSites.length, 1);
  });

  it('does NOT trigger a scan when created disabled', async () => {
    const { deps, enqueuedCalls } = fakeDeps();
    const service = new MonitoredSiteService(deps);
    await service.create('user-1', 'org-1', { name: 'Checkout', url: 'https://example.com', enabled: false });
    assert.equal(enqueuedCalls.length, 0);
  });
});

describe('MonitoredSiteService.runNow', () => {
  it('prevents a duplicate concurrent scan', async () => {
    const sites = new Map([['site-1', fakeSite()]]);
    const activeScans = new Set(['site-1']);
    const { deps } = fakeDeps({ sites, activeScans });
    const service = new MonitoredSiteService(deps);
    await assert.rejects(
      () => service.runNow('site-1', ['org-1'], 'user-1'),
      (error: unknown) => { assert.ok(error instanceof MonitoredSiteError); assert.equal(error.code, 'MONITORED_SITE_SCAN_IN_PROGRESS'); return true; },
    );
  });

  it('enforces workspace isolation — a site in another organization is not found', async () => {
    const sites = new Map([['site-1', fakeSite({ organizationId: 'org-A' })]]);
    const { deps } = fakeDeps({ sites });
    const service = new MonitoredSiteService(deps);
    await assert.rejects(
      () => service.runNow('site-1', ['org-B'], 'user-1'),
      (error: unknown) => { assert.ok(error instanceof MonitoredSiteError); assert.equal(error.code, 'MONITORED_SITE_NOT_FOUND'); return true; },
    );
  });

  it('starts a new scan when none is in progress', async () => {
    const sites = new Map([['site-1', fakeSite()]]);
    const { deps, enqueuedCalls } = fakeDeps({ sites });
    const service = new MonitoredSiteService(deps);
    const result = await service.runNow('site-1', ['org-1'], 'user-1');
    assert.ok(result.scanId);
    assert.equal(enqueuedCalls.length, 1);
  });
});

describe('MonitoredSiteService pause/resume', () => {
  it('pause disables the site', async () => {
    const sites = new Map([['site-1', fakeSite({ enabled: true })]]);
    const { deps } = fakeDeps({ sites });
    const service = new MonitoredSiteService(deps);
    const updated = await service.pause('site-1', ['org-1']);
    assert.equal(updated.enabled, false);
  });

  it('resume re-enables the site and schedules the next scan right away', async () => {
    const sites = new Map([['site-1', fakeSite({ enabled: false, nextScanAt: new Date(Date.now() + 86_400_000).toISOString() })]]);
    const { deps } = fakeDeps({ sites });
    const service = new MonitoredSiteService(deps);
    const before = Date.now();
    const updated = await service.resume('site-1', ['org-1']);
    assert.equal(updated.enabled, true);
    assert.ok(new Date(updated.nextScanAt).getTime() <= Date.now() && new Date(updated.nextScanAt).getTime() >= before - 1000);
  });
});
