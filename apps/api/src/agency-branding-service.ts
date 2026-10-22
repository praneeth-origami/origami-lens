/**
 * Agency plan (V4) white-label branding — validation + entitlement gating
 * on top of AgencyBrandingRepository. Logo storage reuses the existing
 * ArtifactStore.saveImage on-disk layout (the same one Create Bug Report's
 * screenshot uses — "id need not be a scan id", per its own doc comment),
 * never a new upload/storage mechanism.
 */
import type { AgencyBranding, ReportBranding, UpdateAgencyBrandingRequest, AgencyBrandingErrorCode } from '@origami/contracts';
import type { AgencyBrandingRepository, UpdateAgencyBrandingInput } from './db/agency-branding-repository.js';
import type { ArtifactStore } from './artifact-store.js';

export class AgencyBrandingError extends Error {
  constructor(message: string, public readonly code: AgencyBrandingErrorCode) {
    super(message);
    this.name = 'AgencyBrandingError';
  }
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** PNG/JPEG only — deliberately excludes SVG (can embed <script>/event-handler XSS), matching the requirements doc's own warning against "unsafe HTML" or "unvalidated external asset rendering." */
const ALLOWED_LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface AgencyBrandingServiceDeps {
  brandingRepo: AgencyBrandingRepository;
  artifactStore: Pick<ArtifactStore, 'saveImage'>;
  canUseWhiteLabelBranding(organizationId: string): Promise<boolean>;
  logoUrl(organizationId: string, storageKey: string): string;
}

function validateColor(color: string | undefined, field: string): void {
  if (color === undefined) return;
  if (!HEX_COLOR_PATTERN.test(color)) {
    throw new AgencyBrandingError(`${field} must be a hex color like #6d5ef6.`, 'INVALID_COLOR');
  }
}

async function assertAgencyEntitled(deps: AgencyBrandingServiceDeps, organizationId: string): Promise<void> {
  const allowed = await deps.canUseWhiteLabelBranding(organizationId);
  if (!allowed) {
    throw new AgencyBrandingError('Custom branding is available on the Agency plan.', 'NOT_AN_AGENCY_PLAN');
  }
}

/**
 * Resolves the small, display-only ReportBranding slice a report/PDF
 * actually needs — called by the report export route and
 * report-share-service.ts's public resolution, never throws (an org with
 * no Agency entitlement, or no branding configured yet, just gets
 * `undefined`, same as "no branding" — reports never fail to render over
 * a branding lookup).
 */
export async function resolveReportBranding(deps: AgencyBrandingServiceDeps, organizationId: string | undefined): Promise<ReportBranding | undefined> {
  if (!organizationId) return undefined;
  try {
    const allowed = await deps.canUseWhiteLabelBranding(organizationId);
    if (!allowed) return undefined;
    const branding = await deps.brandingRepo.get(organizationId, (key) => deps.logoUrl(organizationId, key));
    if (!branding || (!branding.displayName && !branding.logoUrl && !branding.primaryColor)) return undefined;
    return { displayName: branding.displayName, logoUrl: branding.logoUrl, primaryColor: branding.primaryColor };
  } catch (error) {
    console.error('[agency-branding-service] resolveReportBranding failed, rendering unbranded:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

export async function getAgencyBranding(deps: AgencyBrandingServiceDeps, organizationId: string): Promise<AgencyBranding | undefined> {
  await assertAgencyEntitled(deps, organizationId);
  return deps.brandingRepo.get(organizationId, (key) => deps.logoUrl(organizationId, key));
}

export async function updateAgencyBranding(
  deps: AgencyBrandingServiceDeps,
  organizationId: string,
  request: UpdateAgencyBrandingRequest,
): Promise<AgencyBranding> {
  await assertAgencyEntitled(deps, organizationId);
  validateColor(request.primaryColor, 'Primary color');
  validateColor(request.accentColor, 'Accent color');

  const input: UpdateAgencyBrandingInput = {
    displayName: request.displayName?.trim() || undefined,
    primaryColor: request.primaryColor,
    accentColor: request.accentColor,
    websiteUrl: request.websiteUrl?.trim() || undefined,
    contactEmail: request.contactEmail?.trim() || undefined,
  };
  return deps.brandingRepo.upsert(organizationId, input, (key) => deps.logoUrl(organizationId, key));
}

export async function uploadAgencyLogo(
  deps: AgencyBrandingServiceDeps,
  organizationId: string,
  contentType: string,
  base64: string,
): Promise<AgencyBranding> {
  await assertAgencyEntitled(deps, organizationId);

  const extension = ALLOWED_LOGO_TYPES[contentType];
  if (!extension) {
    throw new AgencyBrandingError('Logo must be a PNG or JPEG image.', 'INVALID_LOGO_TYPE');
  }
  const sizeBytes = Math.ceil((base64.length * 3) / 4);
  if (sizeBytes > MAX_LOGO_BYTES) {
    throw new AgencyBrandingError('Logo must be 2MB or smaller.', 'LOGO_TOO_LARGE');
  }

  const storageKey = `logo.${extension}`;
  deps.artifactStore.saveImage(organizationId, storageKey, base64);
  await deps.brandingRepo.setLogoStorageKey(organizationId, storageKey);

  const branding = await deps.brandingRepo.get(organizationId, (key) => deps.logoUrl(organizationId, key));
  if (!branding) throw new AgencyBrandingError('Failed to save branding.', 'INVALID_LOGO_TYPE');
  return branding;
}
