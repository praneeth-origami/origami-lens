import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgencyBranding } from '@origami/contracts';
import { AgencyBrandingError, getAgencyBranding, updateAgencyBranding, uploadAgencyLogo, type AgencyBrandingServiceDeps } from './agency-branding-service.js';

function fakeDeps(overrides: Partial<{ agencyEntitled: boolean; existing: AgencyBranding }> = {}) {
  const store = new Map<string, AgencyBranding>();
  if (overrides.existing) store.set(overrides.existing.organizationId, overrides.existing);
  const savedImages: Array<{ id: string; key: string; base64: string }> = [];

  const deps: AgencyBrandingServiceDeps = {
    brandingRepo: {
      isEnabled: () => true,
      async get(organizationId) {
        return store.get(organizationId);
      },
      async upsert(organizationId, input, logoUrl) {
        const prior = store.get(organizationId);
        const updated: AgencyBranding = {
          organizationId,
          displayName: input.displayName ?? prior?.displayName,
          logoUrl: prior?.logoUrl,
          primaryColor: input.primaryColor ?? prior?.primaryColor,
          accentColor: input.accentColor ?? prior?.accentColor,
          websiteUrl: input.websiteUrl ?? prior?.websiteUrl,
          contactEmail: input.contactEmail ?? prior?.contactEmail,
          updatedAt: new Date().toISOString(),
        };
        void logoUrl;
        store.set(organizationId, updated);
        return updated;
      },
      async setLogoStorageKey(organizationId, storageKey) {
        const prior = store.get(organizationId) ?? { organizationId, updatedAt: new Date().toISOString() };
        store.set(organizationId, { ...prior, logoUrl: `https://example.com/logo/${storageKey}` });
      },
      async getRaw() {
        return undefined;
      },
    } as unknown as AgencyBrandingServiceDeps['brandingRepo'],
    artifactStore: {
      saveImage: (id, key, base64) => { savedImages.push({ id, key, base64 }); },
    },
    canUseWhiteLabelBranding: async () => overrides.agencyEntitled ?? true,
    logoUrl: (organizationId, key) => `https://example.com/agency/${organizationId}/branding/logo?key=${key}`,
  };

  return { deps, store, savedImages };
}

describe('getAgencyBranding / updateAgencyBranding — Agency plan gating', () => {
  it('rejects every call for a non-Agency organization with NOT_AN_AGENCY_PLAN', async () => {
    const { deps } = fakeDeps({ agencyEntitled: false });
    await assert.rejects(
      () => getAgencyBranding(deps, 'org-1'),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'NOT_AN_AGENCY_PLAN'); return true; },
    );
    await assert.rejects(
      () => updateAgencyBranding(deps, 'org-1', { displayName: 'Acme' }),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'NOT_AN_AGENCY_PLAN'); return true; },
    );
  });

  it('saves and returns branding fields for an Agency organization', async () => {
    const { deps } = fakeDeps();
    const result = await updateAgencyBranding(deps, 'org-1', { displayName: 'Acme Agency', primaryColor: '#123456', websiteUrl: 'https://acme.example' });
    assert.equal(result.displayName, 'Acme Agency');
    assert.equal(result.primaryColor, '#123456');
    assert.equal(result.websiteUrl, 'https://acme.example');
  });

  it('rejects a malformed hex color', async () => {
    const { deps } = fakeDeps();
    await assert.rejects(
      () => updateAgencyBranding(deps, 'org-1', { primaryColor: 'blue' }),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'INVALID_COLOR'); return true; },
    );
  });

  it('partial updates preserve previously-saved fields (never clobbered by an omitted field)', async () => {
    const { deps } = fakeDeps();
    await updateAgencyBranding(deps, 'org-1', { displayName: 'Acme Agency', primaryColor: '#111111' });
    const second = await updateAgencyBranding(deps, 'org-1', { websiteUrl: 'https://acme.example' });
    assert.equal(second.displayName, 'Acme Agency');
    assert.equal(second.primaryColor, '#111111');
    assert.equal(second.websiteUrl, 'https://acme.example');
  });
});

describe('uploadAgencyLogo', () => {
  it('rejects a non-Agency organization', async () => {
    const { deps } = fakeDeps({ agencyEntitled: false });
    await assert.rejects(
      () => uploadAgencyLogo(deps, 'org-1', 'image/png', 'ZmFrZQ=='),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'NOT_AN_AGENCY_PLAN'); return true; },
    );
  });

  it('rejects an unsupported file type (e.g. SVG — can embed scripts)', async () => {
    const { deps } = fakeDeps();
    await assert.rejects(
      () => uploadAgencyLogo(deps, 'org-1', 'image/svg+xml', 'ZmFrZQ=='),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'INVALID_LOGO_TYPE'); return true; },
    );
  });

  it('rejects a logo over the 2MB size limit', async () => {
    const { deps } = fakeDeps();
    const oversized = 'A'.repeat(3 * 1024 * 1024); // base64 chars — well over 2MB decoded
    await assert.rejects(
      () => uploadAgencyLogo(deps, 'org-1', 'image/png', oversized),
      (error: unknown) => { assert.ok(error instanceof AgencyBrandingError); assert.equal(error.code, 'LOGO_TOO_LARGE'); return true; },
    );
  });

  it('accepts a valid PNG logo and persists its storage key', async () => {
    const { deps, savedImages } = fakeDeps();
    const result = await uploadAgencyLogo(deps, 'org-1', 'image/png', 'ZmFrZS1wbmctYnl0ZXM=');
    assert.equal(savedImages.length, 1);
    assert.equal(savedImages[0].id, 'org-1');
    assert.equal(savedImages[0].key, 'logo.png');
    assert.ok(result.logoUrl?.includes('logo.png'));
  });

  it('accepts a valid JPEG logo', async () => {
    const { deps, savedImages } = fakeDeps();
    await uploadAgencyLogo(deps, 'org-1', 'image/jpeg', 'ZmFrZS1qcGVnLWJ5dGVz');
    assert.equal(savedImages[0].key, 'logo.jpg');
  });
});
