import { randomUUID } from 'node:crypto';
import type { CreateLeadResponse, LeadErrorCode, ScanResponse } from '@origami/contracts';
import { isReportReady } from './report-service.js';
import type { LeadRepository } from './db/lead-repository.js';
import { sendLeadNotificationEmail } from './email-service.js';

export class LeadError extends Error {
  constructor(message: string, public readonly code: LeadErrorCode) {
    super(message);
    this.name = 'LeadError';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export interface LeadRequest {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  message?: unknown;
  scanId?: unknown;
  /** Agency plan (V4) — "this is a deliberate lead-audit report, not an organic sales inquiry." Silently downgraded to false for any non-Agency organization (see CreateLeadDeps.canUseAgencyFeatures) rather than rejected — a free-form contact form has no reason to ever reject a request over this. */
  isProspectAudit?: unknown;
}

export interface CreateLeadDeps {
  leadRepo: Pick<LeadRepository, 'create' | 'isEnabled'>;
  /** Returns undefined for "doesn't exist or isn't yours" — same generic-404 posture every other organization-scoped scan lookup already uses. Only consulted when a scanId was supplied, to derive domain/Health Score/issue counts automatically — never to gate whether a lead can be submitted at all. */
  getScanForOrganizations: (scanId: string, organizationIds: string[]) => Promise<ScanResponse | undefined>;
  /** LEADS_NOTIFICATION_EMAIL — undefined means email delivery is skipped (the lead is still recorded); never blocks lead creation on notification failure. */
  notificationEmail?: string;
  /** Agency plan (V4) — gates isProspectAudit:true. Optional so every pre-existing caller/test (no Agency concept yet) keeps working unchanged; absent means "never Agency," i.e. isProspectAudit is always downgraded to false. */
  canUseAgencyFeatures?: (organizationId: string) => Promise<boolean>;
}

/**
 * Origami Lead Generation ("Talk to Origami", roadmap Phase 8). Associates
 * the lead with the caller's own organization and (if scanId is supplied
 * and belongs to that organization) the scan's real domain/Health Score/
 * issue summary — never client-supplied context, always re-derived
 * server-side from the actual scan row. Sends a best-effort internal
 * notification email (never blocks/fails lead creation if that send fails —
 * the lead is already durably recorded before the email is attempted).
 */
export async function createLead(
  organizationId: string | undefined,
  request: LeadRequest,
  deps: CreateLeadDeps,
): Promise<CreateLeadResponse> {
  const name = typeof request.name === 'string' ? request.name.trim() : '';
  const email = typeof request.email === 'string' ? request.email.trim() : '';
  const company = typeof request.company === 'string' && request.company.trim() ? request.company.trim() : undefined;
  const message = typeof request.message === 'string' && request.message.trim() ? request.message.trim() : undefined;
  const scanId = typeof request.scanId === 'string' && request.scanId ? request.scanId : undefined;

  if (!name) throw new LeadError('name is required', 'NAME_REQUIRED');
  if (!EMAIL_PATTERN.test(email)) throw new LeadError('A valid email is required', 'EMAIL_INVALID');

  let domain: string | undefined;
  let healthScore: number | undefined;
  let issueSummary: { critical: number; important: number; improvements: number } | undefined;

  if (scanId) {
    const scan = await deps.getScanForOrganizations(scanId, organizationId ? [organizationId] : []);
    if (!scan) throw new LeadError('Scan not found.', 'SCAN_NOT_FOUND');
    domain = hostnameOf(scan.url);
    if (isReportReady(scan.status)) {
      // bugfix: leads.health_score is an INTEGER column (migration 037),
      // but a real Health Score is rarely a whole number — storing the raw
      // float here throws a real Postgres 22P02 error on almost every
      // scan-linked lead. Rounded, matching how the UI already displays it
      // (e.g. AnimatedScoreRing's Math.round(score)).
      healthScore = Math.round(scan.healthScore.overallScore);
      issueSummary = {
        critical: scan.summary.critical ?? 0,
        important: scan.summary.high ?? 0,
        improvements: (scan.summary.medium ?? 0) + (scan.summary.low ?? 0),
      };
    }
  }

  const requestedProspectAudit = request.isProspectAudit === true;
  const isProspectAudit = requestedProspectAudit && organizationId && deps.canUseAgencyFeatures
    ? await deps.canUseAgencyFeatures(organizationId)
    : false;

  const id = randomUUID();
  if (deps.leadRepo.isEnabled()) {
    await deps.leadRepo.create({ id, organizationId, scanId, name, email, company, message, domain, healthScore, issueSummary, isProspectAudit });
  }

  if (deps.notificationEmail) {
    try {
      await sendLeadNotificationEmail(deps.notificationEmail, {
        name, email, company, message, domain, scanId, healthScore,
        issueSummary: issueSummary ? `${issueSummary.critical} critical, ${issueSummary.important} important, ${issueSummary.improvements} improvements` : undefined,
      });
    } catch (error) {
      console.error('[lead-service] Failed to send lead notification email:', error instanceof Error ? error.message : error);
    }
  }

  return { id };
}
