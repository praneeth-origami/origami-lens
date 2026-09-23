/**
 * Share-link lifecycle for a scan's Lens Report. Same token pattern as
 * workspace-invitation-service.ts's generateToken(): a 32-byte raw token
 * returned to the caller exactly once, paired with its SHA-256 hash stored
 * server-side — see report-share-link-repository.ts / migration 035 for why
 * "create" always rotates rather than trying to redisplay an old link.
 * Ownership is enforced the exact same way every other scan route enforces
 * it (organizationIds membership) — no new permission model.
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { LensReport, ReportErrorCode, ScanResponse } from '@origami/contracts';
import { buildLensReport, isReportReady } from './report-service.js';

export interface ReportShareLinkRepo {
  create(input: { id: string; scanId: string; tokenHash: string; createdBy?: string }): Promise<void>;
  findActiveByScanId(scanId: string): Promise<{ id: string } | undefined>;
  findValidByTokenHash(tokenHash: string): Promise<{ scanId: string } | undefined>;
  revokeActiveByScanId(scanId: string): Promise<void>;
}

export interface ReportShareScanStore {
  getScanForOrganizationsAsync(scanId: string, organizationIds: string[]): Promise<ScanResponse | undefined>;
  getScanAsync(scanId: string): Promise<ScanResponse | undefined>;
}

export class ReportShareError extends Error {
  constructor(message: string, public readonly code: ReportErrorCode | 'SCAN_NOT_FOUND') {
    super(message);
    this.name = 'ReportShareError';
  }
}

function generateShareToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

async function loadOwnedScan(
  deps: { scanStore: ReportShareScanStore },
  scanId: string,
  organizationIds: string[],
): Promise<ScanResponse> {
  const scan = await deps.scanStore.getScanForOrganizationsAsync(scanId, organizationIds);
  if (!scan) throw new ReportShareError('Scan not found.', 'SCAN_NOT_FOUND');
  return scan;
}

export async function createOrRotateReportShare(
  deps: { shareLinkRepo: ReportShareLinkRepo; scanStore: ReportShareScanStore; webAppBaseUrl: string },
  scanId: string,
  organizationIds: string[],
  createdBy: string,
): Promise<{ token: string; url: string }> {
  const scan = await loadOwnedScan(deps, scanId, organizationIds);
  if (!isReportReady(scan.status)) {
    throw new ReportShareError('This scan has not completed successfully yet, so it has no report to share.', 'REPORT_NOT_READY');
  }

  await deps.shareLinkRepo.revokeActiveByScanId(scanId);
  const { rawToken, tokenHash } = generateShareToken();
  await deps.shareLinkRepo.create({ id: randomUUID(), scanId, tokenHash, createdBy });
  return { token: rawToken, url: `${deps.webAppBaseUrl}/reports/share/${rawToken}` };
}

export async function getReportShareStatus(
  deps: { shareLinkRepo: ReportShareLinkRepo; scanStore: ReportShareScanStore },
  scanId: string,
  organizationIds: string[],
): Promise<{ active: boolean }> {
  await loadOwnedScan(deps, scanId, organizationIds);
  const active = await deps.shareLinkRepo.findActiveByScanId(scanId);
  return { active: !!active };
}

export async function revokeReportShare(
  deps: { shareLinkRepo: ReportShareLinkRepo; scanStore: ReportShareScanStore },
  scanId: string,
  organizationIds: string[],
): Promise<void> {
  await loadOwnedScan(deps, scanId, organizationIds);
  await deps.shareLinkRepo.revokeActiveByScanId(scanId);
}

/** Public path — the raw token itself IS the authorization (no organizationIds check, matching /invitations/:token's precedent exactly). */
export async function getSharedReportByToken(
  deps: { shareLinkRepo: ReportShareLinkRepo; scanStore: ReportShareScanStore },
  rawToken: string,
): Promise<LensReport> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const link = await deps.shareLinkRepo.findValidByTokenHash(tokenHash);
  if (!link) throw new ReportShareError('This share link is invalid or has been disabled.', 'REPORT_SHARE_NOT_FOUND');

  const scan = await deps.scanStore.getScanAsync(link.scanId);
  if (!scan) throw new ReportShareError('This share link is invalid or has been disabled.', 'REPORT_SHARE_NOT_FOUND');

  return buildLensReport(scan);
}
