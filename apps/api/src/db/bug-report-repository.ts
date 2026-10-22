import type { BugReport, ConsoleEntry, IssueCategory, NetworkEntry, Severity, BugReportDomEvidence } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateBugReportRow {
  id: string;
  organizationId?: string;
  createdByUserId?: string;
  title: string;
  url: string;
  pageTitle?: string;
  browser: string;
  operatingSystem: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  hasScreenshot: boolean;
  consoleErrors: ConsoleEntry[];
  networkErrors: NetworkEntry[];
  domEvidence?: BugReportDomEvidence;
  description: string;
  severity: Severity;
  category: IssueCategory;
  reproductionSteps: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  suggestedFix?: string;
  linkedIssueId?: string;
  linkedScanId?: string;
}

interface BugReportDbRow {
  id: string;
  title: string;
  url: string;
  page_title: string | null;
  browser: string;
  operating_system: string;
  viewport_width: number;
  viewport_height: number;
  device_pixel_ratio: number;
  has_screenshot: boolean;
  console_errors_json: ConsoleEntry[];
  network_errors_json: NetworkEntry[];
  dom_evidence_json: BugReportDomEvidence | null;
  description: string;
  severity: Severity;
  category: IssueCategory;
  reproduction_steps_json: string[];
  expected_behavior: string | null;
  actual_behavior: string | null;
  suggested_fix: string | null;
  linked_issue_id: string | null;
  linked_scan_id: string | null;
  created_at: string;
  organization_id: string | null;
  github_repository_id: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
}

function toBugReport(row: BugReportDbRow): BugReport {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    pageTitle: row.page_title ?? undefined,
    browser: row.browser,
    operatingSystem: row.operating_system,
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    devicePixelRatio: row.device_pixel_ratio,
    hasScreenshot: row.has_screenshot,
    consoleErrors: row.console_errors_json ?? [],
    networkErrors: row.network_errors_json ?? [],
    domEvidence: row.dom_evidence_json ?? undefined,
    description: row.description,
    severity: row.severity,
    category: row.category,
    reproductionSteps: row.reproduction_steps_json ?? [],
    expectedBehavior: row.expected_behavior ?? undefined,
    actualBehavior: row.actual_behavior ?? undefined,
    suggestedFix: row.suggested_fix ?? undefined,
    linkedIssueId: row.linked_issue_id ?? undefined,
    linkedScanId: row.linked_scan_id ?? undefined,
    createdAt: row.created_at,
    githubRepositoryId: row.github_repository_id ?? undefined,
    githubIssueNumber: row.github_issue_number ?? undefined,
    githubIssueUrl: row.github_issue_url ?? undefined,
  };
}

/**
 * Create Bug Report — a self-contained incident record, distinct from a
 * scan Issue (migration 038). organization_id is how ownership/access is
 * scoped (same resolveOrganizationIds pattern every other route uses) — a
 * report with no organization (shouldn't happen for an authenticated
 * caller, but defensively possible) is never returned by the organization-
 * scoped getter below.
 */
export class BugReportRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateBugReportRow): Promise<BugReport> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query<BugReportDbRow>(
      `INSERT INTO bug_reports (
         id, organization_id, created_by_user_id, title, url, page_title, browser, operating_system,
         viewport_width, viewport_height, device_pixel_ratio, has_screenshot,
         console_errors_json, network_errors_json, dom_evidence_json,
         description, severity, category, reproduction_steps_json,
         expected_behavior, actual_behavior, suggested_fix, linked_issue_id, linked_scan_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        input.id,
        input.organizationId ?? null,
        input.createdByUserId ?? null,
        input.title,
        input.url,
        input.pageTitle ?? null,
        input.browser,
        input.operatingSystem,
        input.viewportWidth,
        input.viewportHeight,
        input.devicePixelRatio,
        input.hasScreenshot,
        JSON.stringify(input.consoleErrors),
        JSON.stringify(input.networkErrors),
        input.domEvidence ? JSON.stringify(input.domEvidence) : null,
        input.description,
        input.severity,
        input.category,
        JSON.stringify(input.reproductionSteps),
        input.expectedBehavior ?? null,
        input.actualBehavior ?? null,
        input.suggestedFix ?? null,
        input.linkedIssueId ?? null,
        input.linkedScanId ?? null,
      ],
    );
    return toBugReport(result.rows[0]!);
  }

  async getByIdForOrganizationsAsync(id: string, organizationIds: string[]): Promise<BugReport | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    if (organizationIds.length === 0) return undefined;
    const result = await pool.query<BugReportDbRow>(
      `SELECT * FROM bug_reports WHERE id = $1 AND organization_id = ANY($2::uuid[])`,
      [id, organizationIds],
    );
    const row = result.rows[0];
    return row ? toBugReport(row) : undefined;
  }

  /**
   * Persists a bug report's GitHub issue link the FIRST time Create GitHub
   * Issue succeeds (migration 039) — the WHERE clause only writes when no
   * link exists yet, so even a racing double-click can't overwrite an
   * already-recorded link with a second, different issue reference.
   */
  async linkGitHubIssue(id: string, link: { repositoryId: string; issueNumber: number; issueUrl: string }): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `UPDATE bug_reports
       SET github_repository_id = $2, github_issue_number = $3, github_issue_url = $4
       WHERE id = $1 AND github_issue_url IS NULL`,
      [id, link.repositoryId, link.issueNumber, link.issueUrl],
    );
  }
}
