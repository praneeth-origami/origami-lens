import type {
  AggregatedIssue,
  AiScanSummary,
  BrowserEvidence,
  DiscoveryMethod,
  EvidenceSummary,
  FailedPageRecord,
  GitHubIssueLink,
  Issue,
  IssueOccurrence,
  IssueStatus,
  PageScanRecord,
  ScanArtifacts,
  ScanListItem,
  ScanProgress,
  ScanResponse,
  ScanStatus,
  ScanSummary,
  ScanType,
  WebsiteScanOptions,
} from '@origami/contracts';
import { DEFAULT_WEBSITE_MAX_PAGES, MAX_WEBSITE_PAGES } from '@origami/contracts';
import { randomUUID } from 'node:crypto';
import { getPool } from './pool.js';

interface CreateScanInput {
  scanId: string;
  scanType: ScanType;
  rootUrl: string;
  ownerId?: string;
  /** The real ownership boundary (see migration 018) — always the creating user's organization, resolved server-side, never client-supplied. */
  organizationId?: string;
  discoveryMethod?: DiscoveryMethod;
  maxPages?: number;
  status?: ScanStatus;
  /** Set only when this scan was created BY continuous monitoring (scheduled or manual "Run Now"), never by an ordinary one-off scan — see migration 041 and monitored-site-service.ts. */
  monitoredSiteId?: string;
}

export class ScanRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async createScan(input: CreateScanInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    await pool.query(
      `INSERT INTO scans (id, scan_type, status, root_url, owner_id, organization_id, discovery_method, max_pages, progress_json, monitored_site_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.scanId,
        input.scanType,
        input.status ?? 'QUEUED',
        input.rootUrl,
        input.ownerId ?? null,
        input.organizationId ?? null,
        input.discoveryMethod ?? null,
        input.maxPages ?? null,
        JSON.stringify({ discoveredPages: 0, completedPages: 0, failedPages: 0, issuesFound: 0 }),
        input.monitoredSiteId ?? null,
      ],
    );
  }

  /** Scan history for a monitored site (newest first) — the existing `scans` table is the sole source of truth (migration 041), so this is a plain filtered read, never a second scan-data store. */
  async listScansForMonitoredSite(monitoredSiteId: string, limit = 30): Promise<ScanResponse[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT id FROM scans WHERE monitored_site_id = $1 ORDER BY created_at DESC LIMIT $2`, [monitoredSiteId, limit]);
    const scans: ScanResponse[] = [];
    for (const row of result.rows) {
      const scan = await this.getScan(row.id);
      if (scan) scans.push(scan);
    }
    return scans;
  }

  /** The most recently COMPLETED (or COMPLETED_WITH_WARNINGS) scan for a monitored site before the given one — the day-over-day regression comparison point, distinct from the site's frozen baseline_scan_id (see migration 041's doc comment). */
  async getPreviousCompletedScanForMonitoredSite(monitoredSiteId: string, beforeScanId: string): Promise<ScanResponse | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const beforeRow = await pool.query(`SELECT created_at FROM scans WHERE id = $1`, [beforeScanId]);
    if (beforeRow.rows.length === 0) return undefined;
    const result = await pool.query(
      `SELECT id FROM scans
       WHERE monitored_site_id = $1 AND id != $2 AND created_at < $3 AND status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
       ORDER BY created_at DESC LIMIT 1`,
      [monitoredSiteId, beforeScanId, beforeRow.rows[0].created_at],
    );
    if (result.rows.length === 0) return undefined;
    return this.getScan(result.rows[0].id);
  }

  /** Is a scan already in flight for this monitored site — the server-side duplicate-concurrent-run guard (manual "Run Now" and the scheduler sweep both check this before enqueueing), reusing the same scans.status column the admin activity dashboard already reads rather than a new marker column. */
  async hasActiveScanForMonitoredSite(monitoredSiteId: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(`SELECT 1 FROM scans WHERE monitored_site_id = $1 AND status IN ('QUEUED', 'RUNNING') LIMIT 1`, [monitoredSiteId]);
    return result.rows.length > 0;
  }

  async updateScanStatus(scanId: string, status: ScanStatus, error?: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE scans SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`,
      [scanId, status, error ?? null],
    );
  }

  async updateProgress(scanId: string, progress: ScanProgress): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE scans SET progress_json = $2, updated_at = NOW() WHERE id = $1`,
      [scanId, JSON.stringify(progress)],
    );
  }

  /**
   * Adds one page scan mid-crawl, without touching scan-level progress —
   * unlike createPageScans (below), which is only safe to call once, for the
   * initial seed batch, since it resets discoveredPages/completedPages/etc.
   * Used when AUTOMATIC discovery finds new same-origin links while actually
   * scanning a page (see website-scan-orchestrator.ts), so the queue can
   * grow past the initial seed.
   */
  async createPageScan(scanId: string, url: string): Promise<string> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const pageScanId = randomUUID();
    await pool.query(
      `INSERT INTO page_scans (id, scan_id, url, status) VALUES ($1, $2, $3, 'QUEUED')`,
      [pageScanId, scanId, url],
    );
    return pageScanId;
  }

  async createPageScans(scanId: string, urls: string[]): Promise<Map<string, string>> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const idByUrl = new Map<string, string>();
    for (const url of urls) {
      const pageScanId = randomUUID();
      idByUrl.set(url, pageScanId);
      await pool.query(
        `INSERT INTO page_scans (id, scan_id, url, status) VALUES ($1, $2, $3, 'QUEUED')`,
        [pageScanId, scanId, url],
      );
    }

    await this.updateProgress(scanId, {
      discoveredPages: urls.length,
      completedPages: 0,
      failedPages: 0,
      issuesFound: 0,
    });

    return idByUrl;
  }

  async updatePageScan(
    pageScanId: string,
    data: {
      status: ScanStatus;
      error?: string;
      healthScore?: object;
      evidenceSummary?: EvidenceSummary;
      /** Already privacy-scrubbed/screenshot-stripped (page-scan-runner.ts's PageScanResult.evidence) — persisted verbatim for "Ask About This Page" (page-qa-service.ts), never re-sanitized here. */
      fullEvidence?: BrowserEvidence;
      artifacts?: ScanArtifacts;
      scannedAt?: string;
    },
  ): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE page_scans SET status = $2, error = $3, health_score_json = $4,
       evidence_summary_json = $5, artifacts_json = $6, scanned_at = $7, full_evidence_json = $8
       WHERE id = $1`,
      [
        pageScanId,
        data.status,
        data.error ?? null,
        data.healthScore ? JSON.stringify(data.healthScore) : null,
        data.evidenceSummary ? JSON.stringify(data.evidenceSummary) : null,
        data.artifacts ? JSON.stringify(data.artifacts) : null,
        data.scannedAt ?? null,
        data.fullEvidence ? JSON.stringify(data.fullEvidence) : null,
      ],
    );
  }

  async savePageIssues(scanId: string, pageScanId: string, issues: Issue[]): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    for (const issue of issues) {
      await pool.query(
        `INSERT INTO issues (id, scan_id, page_scan_id, is_aggregated, rule_id, type, category, severity,
         title, problem, cause, impact, suggested_fix, confidence, source, status, group_key, evidence_json)
         VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          issue.id,
          scanId,
          pageScanId,
          issue.ruleId ?? null,
          issue.type,
          issue.category,
          issue.severity,
          issue.title,
          issue.problem,
          issue.cause,
          issue.impact,
          issue.suggestedFix,
          issue.confidence,
          issue.source,
          issue.status ?? 'open',
          issue.groupKey ?? null,
          JSON.stringify(issue.evidence),
        ],
      );
    }
  }

  async saveAggregatedIssues(scanId: string, issues: AggregatedIssue[]): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    for (const issue of issues) {
      await pool.query(
        `INSERT INTO issues (id, scan_id, page_scan_id, is_aggregated, rule_id, type, category, severity,
         title, problem, cause, impact, suggested_fix, confidence, source, status, group_key, evidence_json,
         occurrence_count, affected_pages)
         VALUES ($1,$2,null,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          issue.id,
          scanId,
          issue.ruleId ?? null,
          issue.type,
          issue.category,
          issue.severity,
          issue.title,
          issue.problem,
          issue.cause,
          issue.impact,
          issue.suggestedFix,
          issue.confidence,
          issue.source,
          issue.status ?? 'open',
          issue.groupKey ?? null,
          JSON.stringify(issue.evidence),
          issue.occurrenceCount,
          JSON.stringify(issue.affectedPages),
        ],
      );

      for (const occ of issue.occurrences) {
        await pool.query(
          `INSERT INTO issue_occurrences (id, aggregated_issue_id, page_scan_id, url, evidence_json)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), issue.id, occ.pageScanId, occ.url, JSON.stringify(occ.evidence)],
        );
      }
    }
  }

  async completeScan(
    scanId: string,
    data: {
      status: ScanStatus;
      healthScore?: object;
      summary?: ScanSummary;
      aiSummary?: AiScanSummary;
      evidenceSummary?: EvidenceSummary;
      artifacts?: ScanArtifacts;
      scannedAt: string;
      error?: string;
    },
  ): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE scans SET status = $2, health_score_json = $3, summary_json = $4, ai_summary_json = $5,
       evidence_summary_json = $6, artifacts_json = $7, scanned_at = $8, error = $9, updated_at = NOW()
       WHERE id = $1`,
      [
        scanId,
        data.status,
        data.healthScore ? JSON.stringify(data.healthScore) : null,
        data.summary ? JSON.stringify(data.summary) : null,
        data.aiSummary ? JSON.stringify(data.aiSummary) : null,
        data.evidenceSummary ? JSON.stringify(data.evidenceSummary) : null,
        data.artifacts ? JSON.stringify(data.artifacts) : null,
        data.scannedAt,
        data.error ?? null,
      ],
    );
  }

  /** `fullEvidence` is already privacy-scrubbed/screenshot-stripped (page-scan-runner.ts's PageScanResult.evidence) — kept as a separate param rather than a ScanResponse field so the (potentially large) evidence blob never rides along on the public scan-fetch contract; persisted verbatim for "Ask About This Page" (page-qa-service.ts). */
  async saveCurrentPageScan(response: ScanResponse, fullEvidence?: BrowserEvidence): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `INSERT INTO scans (id, scan_type, status, root_url, owner_id, organization_id, progress_json, health_score_json,
       summary_json, ai_summary_json, evidence_summary_json, artifacts_json, scanned_at, full_evidence_json)
       VALUES ($1, 'CURRENT_PAGE', 'COMPLETED', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         health_score_json = EXCLUDED.health_score_json,
         summary_json = EXCLUDED.summary_json,
         ai_summary_json = EXCLUDED.ai_summary_json,
         evidence_summary_json = EXCLUDED.evidence_summary_json,
         artifacts_json = EXCLUDED.artifacts_json,
         scanned_at = EXCLUDED.scanned_at,
         full_evidence_json = EXCLUDED.full_evidence_json,
         updated_at = NOW()`,
      [
        response.scanId,
        response.url,
        response.ownerId ?? null,
        response.organizationId ?? null,
        JSON.stringify(response.progress ?? { discoveredPages: 1, completedPages: 1, failedPages: 0, issuesFound: response.issues.length }),
        JSON.stringify(response.healthScore),
        JSON.stringify(response.summary),
        response.aiSummary ? JSON.stringify(response.aiSummary) : null,
        response.evidenceSummary ? JSON.stringify(response.evidenceSummary) : null,
        response.artifacts ? JSON.stringify(response.artifacts) : null,
        response.scannedAt,
        fullEvidence ? JSON.stringify(fullEvidence) : null,
      ],
    );

    for (const issue of response.issues) {
      await pool.query(
        `INSERT INTO issues (id, scan_id, page_scan_id, is_aggregated, rule_id, type, category, severity,
         title, problem, cause, impact, suggested_fix, confidence, source, status, group_key, evidence_json)
         VALUES ($1,$2,null,false,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO NOTHING`,
        [
          issue.id,
          response.scanId,
          issue.ruleId ?? null,
          issue.type,
          issue.category,
          issue.severity,
          issue.title,
          issue.problem,
          issue.cause,
          issue.impact,
          issue.suggestedFix,
          issue.confidence,
          issue.source,
          issue.status ?? 'open',
          issue.groupKey ?? null,
          JSON.stringify(issue.evidence),
        ],
      );
    }
  }

  async getScan(scanId: string): Promise<ScanResponse | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const scanResult = await pool.query(`SELECT * FROM scans WHERE id = $1`, [scanId]);
    if (scanResult.rows.length === 0) return undefined;

    const row = scanResult.rows[0];
    const issues = await this.loadIssues(scanId, row.scan_type === 'WEBSITE');
    const pages = row.scan_type === 'WEBSITE' ? await this.loadPageScans(scanId) : undefined;
    const failedPages = pages?.filter((p) => p.status === 'FAILED').map((p) => ({
      url: p.url,
      pageScanId: p.pageScanId,
      error: p.error ?? 'Unknown error',
    })) as FailedPageRecord[] | undefined;

    return {
      scanId: row.id,
      url: row.root_url,
      scanType: row.scan_type,
      status: row.status,
      healthScore: row.health_score_json ?? {
        overallScore: 0,
        categories: {
          functional: { score: 0, weight: 25 },
          performance: { score: 0, weight: 20 },
          visualMobile: { score: 0, weight: 20 },
          accessibility: { score: 0, weight: 15 },
          bestPractices: { score: 0, weight: 10 },
          seo: { score: 0, weight: 5 },
          securityHygiene: { score: 0, weight: 5 },
        },
      },
      issues,
      summary: row.summary_json ?? { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, aiAvailable: false },
      scannedAt: row.scanned_at?.toISOString() ?? row.created_at.toISOString(),
      artifacts: row.artifacts_json ?? undefined,
      aiSummary: row.ai_summary_json ?? undefined,
      evidenceSummary: row.evidence_summary_json ?? undefined,
      progress: row.progress_json,
      pages,
      failedPages: failedPages && failedPages.length > 0 ? failedPages : undefined,
      discoveryMethod: row.discovery_method ?? undefined,
      ownerId: row.owner_id ?? undefined,
      organizationId: row.organization_id ?? undefined,
      error: row.error ?? undefined,
    };
  }

  /**
   * Deletes a scan and everything under it (page_scans, issues,
   * issue_occurrences — all ON DELETE CASCADE, see migration 001) in one
   * statement, but only if it belongs to one of the caller's organizations.
   * Returns false for "doesn't exist" and "exists but isn't yours"
   * identically — same generic-404 convention as every other
   * ForOrganizations method, just expressed as a boolean since there's no
   * row left to return. Screenshot files on disk are NOT touched here —
   * see artifact-store.ts's deleteScanArtifacts, which the caller (index.ts)
   * invokes separately after this succeeds.
   */
  async deleteScanForOrganizations(scanId: string, organizationIds: string[]): Promise<boolean> {
    if (organizationIds.length === 0) return false;
    const pool = getPool();
    if (!pool) return false;

    const result = await pool.query(`DELETE FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [scanId, organizationIds]);
    return (result.rowCount ?? 0) > 0;
  }

  /** The authorization-aware lookup — filters at the SQL layer so a scan belonging to another organization never leaves the database. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. */
  async getScanForOrganizations(scanId: string, organizationIds: string[]): Promise<ScanResponse | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(`SELECT id FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [scanId, organizationIds]);
    if (result.rows.length === 0) return undefined;
    return this.getScan(scanId);
  }

  async getScanStatus(scanId: string): Promise<{
    scanId: string;
    scanType: ScanType;
    status: ScanStatus;
    progress: ScanProgress;
    healthScore?: object;
    error?: string;
  } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `SELECT id, scan_type, status, progress_json, health_score_json, error FROM scans WHERE id = $1`,
      [scanId],
    );
    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    return {
      scanId: row.id,
      scanType: row.scan_type,
      status: row.status,
      progress: row.progress_json,
      healthScore: row.health_score_json ?? undefined,
      error: row.error ?? undefined,
    };
  }

  async getScanStatusForOrganizations(scanId: string, organizationIds: string[]): Promise<{
    scanId: string;
    scanType: ScanType;
    status: ScanStatus;
    progress: ScanProgress;
    healthScore?: object;
    error?: string;
  } | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `SELECT id, scan_type, status, progress_json, health_score_json, error FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`,
      [scanId, organizationIds],
    );
    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    return {
      scanId: row.id,
      scanType: row.scan_type,
      status: row.status,
      progress: row.progress_json,
      healthScore: row.health_score_json ?? undefined,
      error: row.error ?? undefined,
    };
  }

  async listScans(): Promise<ScanListItem[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = await pool.query(
      `SELECT id, root_url, scan_type, status, health_score_json, summary_json, scanned_at, created_at
       FROM scans ORDER BY COALESCE(scanned_at, created_at) DESC LIMIT 100`,
    );

    return result.rows.map((row) => ({
      scanId: row.id,
      url: row.root_url,
      overallScore: row.health_score_json?.overallScore ?? 0,
      totalIssues: row.summary_json?.totalIssues ?? 0,
      critical: row.summary_json?.critical,
      high: row.summary_json?.high,
      medium: row.summary_json?.medium,
      low: row.summary_json?.low,
      scannedAt: (row.scanned_at ?? row.created_at).toISOString(),
      scanType: row.scan_type,
      status: row.status,
    }));
  }

  /** The only listing a real, authenticated caller ever gets — always scoped to every organization they belong to, never an optional filter. */
  async listScansForOrganizations(organizationIds: string[]): Promise<ScanListItem[]> {
    if (organizationIds.length === 0) return [];
    const pool = getPool();
    if (!pool) return [];

    const result = await pool.query(
      `SELECT id, root_url, scan_type, status, health_score_json, summary_json, scanned_at, created_at
       FROM scans WHERE organization_id = ANY($1::uuid[]) ORDER BY COALESCE(scanned_at, created_at) DESC LIMIT 100`,
      [organizationIds],
    );

    return result.rows.map((row) => ({
      scanId: row.id,
      url: row.root_url,
      overallScore: row.health_score_json?.overallScore ?? 0,
      totalIssues: row.summary_json?.totalIssues ?? 0,
      critical: row.summary_json?.critical,
      high: row.summary_json?.high,
      medium: row.summary_json?.medium,
      low: row.summary_json?.low,
      scannedAt: (row.scanned_at ?? row.created_at).toISOString(),
      scanType: row.scan_type,
      status: row.status,
    }));
  }

  async getPageScans(scanId: string): Promise<PageScanRecord[]> {
    return this.loadPageScans(scanId);
  }

  /** Returns undefined for "scan doesn't exist or isn't yours" (generic 404), an empty array for "yours, but no pages yet." */
  async getPageScansForOrganizations(scanId: string, organizationIds: string[]): Promise<PageScanRecord[] | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const owned = await pool.query(`SELECT id FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [scanId, organizationIds]);
    if (owned.rows.length === 0) return undefined;
    return this.loadPageScans(scanId);
  }

  async getPageScanDetail(scanId: string, pageScanId: string): Promise<{
    page: PageScanRecord;
    issues: Issue[];
  } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const pageResult = await pool.query(
      `SELECT * FROM page_scans WHERE id = $1 AND scan_id = $2`,
      [pageScanId, scanId],
    );
    if (pageResult.rows.length === 0) return undefined;

    const row = pageResult.rows[0];
    const issuesResult = await pool.query(
      `SELECT * FROM issues WHERE page_scan_id = $1 AND is_aggregated = false`,
      [pageScanId],
    );

    return {
      page: this.rowToPageScan(row),
      issues: issuesResult.rows.map((r) => this.rowToIssue(r)),
    };
  }

  async getPageScanDetailForOrganizations(scanId: string, pageScanId: string, organizationIds: string[]): Promise<{
    page: PageScanRecord;
    issues: Issue[];
  } | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const owned = await pool.query(`SELECT id FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [scanId, organizationIds]);
    if (owned.rows.length === 0) return undefined;
    return this.getPageScanDetail(scanId, pageScanId);
  }

  /**
   * Narrow accessor used only by "Ask About This Page" (page-qa-service.ts)
   * for a CURRENT_PAGE scan — never by the general scan-fetch routes, so the
   * (potentially large) full_evidence_json blob is never loaded on every
   * ordinary scan-detail view. `fullEvidence` is undefined for a scan that
   * predates migration 036 (never backfilled) or wasn't a CURRENT_PAGE scan.
   */
  async getScanEvidenceForOrganizations(scanId: string, organizationIds: string[]): Promise<{
    scanId: string;
    url: string;
    scanType: ScanType;
    status: ScanStatus;
    healthScore?: object;
    fullEvidence?: BrowserEvidence;
    issues: Issue[];
    issueCount: number;
  } | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `SELECT s.id, s.root_url, s.scan_type, s.status, s.health_score_json, s.full_evidence_json
       FROM scans s WHERE s.id = $1 AND s.organization_id = ANY($2::uuid[])`,
      [scanId, organizationIds],
    );
    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    const { issues, issueCount } = await this.loadIssuesForQa('scan_id', scanId);
    return {
      scanId: row.id,
      url: row.root_url,
      scanType: row.scan_type,
      status: row.status,
      healthScore: row.health_score_json ?? undefined,
      fullEvidence: row.full_evidence_json ?? undefined,
      issues,
      issueCount,
    };
  }

  /**
   * The root page of a WEBSITE scan (the first page_scan row created —
   * discoverPages always seeds the root URL first, see
   * website-scan-orchestrator.ts) — used only by the continuous-monitoring
   * regression engine, which already trusts the scanId it's given (it
   * created that scan itself), so this deliberately skips the
   * organization-ownership re-check every caller-facing accessor above
   * does. The returned `pageScanId` composite id (`${scanId}/${pageScanId}`)
   * is the exact key ArtifactStore/PageScanRunner already use for a
   * website page's own screenshots — see persistArtifacts in
   * page-scan-runner.ts.
   */
  async getRootPageScanData(scanId: string): Promise<{ pageScanId: string; url: string; fullEvidence?: BrowserEvidence; artifacts?: ScanArtifacts } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT id, url, full_evidence_json, artifacts_json FROM page_scans WHERE scan_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [scanId],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return {
      pageScanId: row.id,
      url: row.url,
      fullEvidence: row.full_evidence_json ?? undefined,
      artifacts: row.artifacts_json ?? undefined,
    };
  }

  /** Same posture as getScanEvidenceForOrganizations above, for a WEBSITE scan's individual page_scans row. */
  async getPageScanEvidenceForOrganizations(scanId: string, pageScanId: string, organizationIds: string[]): Promise<{
    pageScanId: string;
    url: string;
    status: ScanStatus;
    healthScore?: object;
    fullEvidence?: BrowserEvidence;
    issues: Issue[];
    issueCount: number;
  } | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const owned = await pool.query(`SELECT id FROM scans WHERE id = $1 AND organization_id = ANY($2::uuid[])`, [scanId, organizationIds]);
    if (owned.rows.length === 0) return undefined;

    const result = await pool.query(
      `SELECT ps.id, ps.url, ps.status, ps.health_score_json, ps.full_evidence_json
       FROM page_scans ps WHERE ps.id = $1 AND ps.scan_id = $2`,
      [pageScanId, scanId],
    );
    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    const { issues, issueCount } = await this.loadIssuesForQa('page_scan_id', pageScanId);
    return {
      pageScanId: row.id,
      url: row.url,
      status: row.status,
      healthScore: row.health_score_json ?? undefined,
      fullEvidence: row.full_evidence_json ?? undefined,
      issues,
      issueCount,
    };
  }

  /**
   * Used only by "Ask About This Page" (page-qa-service.ts) — returns the
   * total issue count plus a severity-ordered, bounded sample (never
   * unbounded: page-qa-context.ts further caps how many it actually uses,
   * but this keeps the DB round trip itself bounded regardless).
   */
  private async loadIssuesForQa(column: 'scan_id' | 'page_scan_id', id: string): Promise<{ issues: Issue[]; issueCount: number }> {
    const pool = getPool();
    if (!pool) return { issues: [], issueCount: 0 };

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM issues WHERE ${column} = $1`, [id]);
    const issueCount = countResult.rows[0]?.count ?? 0;

    const result = await pool.query(
      `SELECT * FROM issues WHERE ${column} = $1
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END
       LIMIT 50`,
      [id],
    );
    return { issues: result.rows.map((r) => this.rowToIssue(r)), issueCount };
  }

  async getIssue(issueId: string): Promise<{ issue: Issue | AggregatedIssue; scan: ScanResponse } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const issueResult = await pool.query(`SELECT * FROM issues WHERE id = $1`, [issueId]);
    if (issueResult.rows.length === 0) return undefined;

    const issueRow = issueResult.rows[0];
    const scan = await this.getScan(issueRow.scan_id);
    if (!scan) return undefined;
    const githubIssueLinks = await this.loadGitHubIssueLinks(issueId);

    if (issueRow.is_aggregated) {
      const occResult = await pool.query(
        `SELECT * FROM issue_occurrences WHERE aggregated_issue_id = $1`,
        [issueId],
      );
      const aggregated: AggregatedIssue = {
        ...this.rowToIssue(issueRow),
        occurrenceCount: issueRow.occurrence_count ?? 0,
        affectedPages: issueRow.affected_pages ?? [],
        occurrences: occResult.rows.map((r) => ({
          pageScanId: r.page_scan_id,
          url: r.url,
          evidence: r.evidence_json,
        })) as IssueOccurrence[],
        isAggregated: true,
        githubIssueLinks,
      };
      return { issue: aggregated, scan };
    }

    return { issue: { ...this.rowToIssue(issueRow), githubIssueLinks }, scan };
  }

  /** The authorization-aware lookup — an issue belongs to whichever scan found it, so ownership is checked via that scan's organization_id. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. */
  async getIssueForOrganizations(issueId: string, organizationIds: string[]): Promise<{ issue: Issue | AggregatedIssue; scan: ScanResponse } | undefined> {
    if (organizationIds.length === 0) return undefined;
    const found = await this.getIssue(issueId);
    if (!found || !found.scan.organizationId || !organizationIds.includes(found.scan.organizationId)) return undefined;
    return found;
  }

  async updateIssueStatus(issueId: string, status: IssueStatus): Promise<Issue | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `UPDATE issues SET status = $2 WHERE id = $1 RETURNING *`,
      [issueId, status],
    );
    if (result.rows.length === 0) return undefined;
    return this.rowToIssue(result.rows[0]);
  }

  /** The authorization-aware mutation — verifies the issue's scan belongs to one of the caller's organizations before writing, using the same rule as getIssueForOrganizations. Returns undefined for "doesn't exist" and "exists but isn't yours" identically (no change is made either way). */
  async updateIssueStatusForOrganizations(issueId: string, status: IssueStatus, organizationIds: string[]): Promise<Issue | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;

    const owned = await pool.query(
      `SELECT i.id FROM issues i JOIN scans s ON s.id = i.scan_id WHERE i.id = $1 AND s.organization_id = ANY($2::uuid[])`,
      [issueId, organizationIds],
    );
    if (owned.rows.length === 0) return undefined;
    return this.updateIssueStatus(issueId, status);
  }

  /** Persists which repository a finding's AI fix/PR should target (migration 019, see repository-finding-resolution-service.ts) — same shape as updateIssueStatus, just a different column. */
  async updateIssueRepository(issueId: string, repositoryId: string): Promise<Issue | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(
      `UPDATE issues SET repository_id = $2 WHERE id = $1 RETURNING *`,
      [issueId, repositoryId],
    );
    if (result.rows.length === 0) return undefined;
    return this.rowToIssue(result.rows[0]);
  }

  private async loadGitHubIssueLinks(issueId: string): Promise<GitHubIssueLink[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM github_issue_links WHERE issue_id = $1 ORDER BY created_at`, [issueId]);
    return result.rows.map((r) => this.rowToGitHubIssueLink(r));
  }

  /** Server-side authority for "does this finding already have a GitHub Issue in this repository" (migration 040) — checked before ever calling the real GitHub API, never trusting client/React state. */
  async findGitHubIssueLink(issueId: string, repositoryId: string, provider: string): Promise<GitHubIssueLink | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(
      `SELECT * FROM github_issue_links WHERE issue_id = $1 AND repository_id = $2 AND provider = $3`,
      [issueId, repositoryId, provider],
    );
    if (result.rows.length === 0) return undefined;
    return this.rowToGitHubIssueLink(result.rows[0]);
  }

  /**
   * Atomically records a newly-created GitHub Issue (migration 040) — the
   * UNIQUE(issue_id, repository_id, provider) constraint plus
   * `ON CONFLICT DO NOTHING` makes this the race-safe primitive: if two
   * requests both reach this call for the same finding+repository (e.g. two
   * near-simultaneous clicks), only ONE insert ever lands; the other gets
   * `alreadyExisted: true` with the WINNING row's own issue number/url, so
   * the system never reports two different issue numbers for the same
   * finding+repository even under a race. (Calling the real GitHub API
   * itself is separately serialized per-process in
   * repository-github-issue-service.ts — this guard is the last line of
   * defense, not the only one.)
   */
  async linkGitHubIssue(
    issueId: string,
    link: { repositoryId: string; provider: string; githubOwner: string; githubRepository: string; issueNumber: number; issueUrl: string; createdByUserId?: string },
  ): Promise<{ alreadyExisted: boolean; link: GitHubIssueLink }> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    const inserted = await pool.query(
      `INSERT INTO github_issue_links (id, issue_id, repository_id, provider, github_owner, github_repository, github_issue_number, github_issue_url, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (issue_id, repository_id, provider) DO NOTHING
       RETURNING *`,
      [randomUUID(), issueId, link.repositoryId, link.provider, link.githubOwner, link.githubRepository, link.issueNumber, link.issueUrl, link.createdByUserId ?? null],
    );
    if (inserted.rows.length > 0) {
      return { alreadyExisted: false, link: this.rowToGitHubIssueLink(inserted.rows[0]) };
    }

    const existing = await this.findGitHubIssueLink(issueId, link.repositoryId, link.provider);
    if (!existing) throw new Error('github_issue_links insert conflicted but no existing row was found');
    return { alreadyExisted: true, link: existing };
  }

  private rowToGitHubIssueLink(row: Record<string, unknown>): GitHubIssueLink {
    return {
      repositoryId: row.repository_id as string,
      provider: row.provider as string,
      githubOwner: row.github_owner as string,
      githubRepository: row.github_repository as string,
      issueNumber: row.github_issue_number as number,
      issueUrl: row.github_issue_url as string,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private async loadPageScans(scanId: string): Promise<PageScanRecord[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = await pool.query(
      `SELECT ps.*, (SELECT COUNT(*)::int FROM issues i WHERE i.page_scan_id = ps.id) AS issue_count
       FROM page_scans ps WHERE ps.scan_id = $1 ORDER BY ps.created_at`,
      [scanId],
    );

    return result.rows.map((row) => this.rowToPageScan(row, row.issue_count));
  }

  private async loadIssues(scanId: string, website: boolean): Promise<Issue[] | AggregatedIssue[]> {
    const pool = getPool();
    if (!pool) return [];

    if (website) {
      const result = await pool.query(
        `SELECT * FROM issues WHERE scan_id = $1 AND is_aggregated = true ORDER BY severity, title`,
        [scanId],
      );
      const aggregated: AggregatedIssue[] = [];
      for (const row of result.rows) {
        const occResult = await pool.query(
          `SELECT * FROM issue_occurrences WHERE aggregated_issue_id = $1`,
          [row.id],
        );
        aggregated.push({
          ...this.rowToIssue(row),
          occurrenceCount: row.occurrence_count ?? 0,
          affectedPages: row.affected_pages ?? [],
          occurrences: occResult.rows.map((r) => ({
            pageScanId: r.page_scan_id,
            url: r.url,
            evidence: r.evidence_json,
          })),
          isAggregated: true,
        });
      }
      return aggregated;
    }

    const result = await pool.query(
      `SELECT * FROM issues WHERE scan_id = $1 AND (is_aggregated = false OR page_scan_id IS NULL) ORDER BY severity, title`,
      [scanId],
    );
    return result.rows.map((r) => this.rowToIssue(r));
  }

  private rowToPageScan(row: Record<string, unknown>, issueCount?: number): PageScanRecord {
    return {
      pageScanId: row.id as string,
      url: row.url as string,
      status: row.status as ScanStatus,
      error: (row.error as string) ?? undefined,
      healthScore: row.health_score_json as PageScanRecord['healthScore'],
      issueCount: issueCount ?? undefined,
      scannedAt: row.scanned_at ? (row.scanned_at as Date).toISOString() : undefined,
    };
  }

  private rowToIssue(row: Record<string, unknown>): Issue {
    return {
      id: row.id as string,
      scanId: row.scan_id as string,
      category: row.category as Issue['category'],
      type: row.type as string,
      ruleId: (row.rule_id as string) ?? undefined,
      severity: row.severity as Issue['severity'],
      title: row.title as string,
      evidence: row.evidence_json as Issue['evidence'],
      confidence: (row.confidence as number) ?? 0.8,
      impact: (row.impact as string) ?? '',
      source: row.source as Issue['source'],
      problem: (row.problem as string) ?? '',
      cause: (row.cause as string) ?? '',
      suggestedFix: (row.suggested_fix as string) ?? '',
      status: (row.status as IssueStatus) ?? 'open',
      groupKey: (row.group_key as string) ?? undefined,
      url: undefined,
      repositoryId: (row.repository_id as string) ?? undefined,
    };
  }
}

/**
 * Server-configurable default page budget. MAX_WEBSITE_PAGES (from
 * @origami/contracts) is the hard safety ceiling and is never itself
 * configurable — this only lets an operator lower or raise the *default*
 * used when a request doesn't specify its own maxPages, without touching code.
 */
function defaultMaxPages(): number {
  const configured = Number(process.env.WEBSITE_SCAN_MAX_PAGES);
  return configured > 0 ? Math.min(configured, MAX_WEBSITE_PAGES) : DEFAULT_WEBSITE_MAX_PAGES;
}

export function resolveWebsiteOptions(options?: WebsiteScanOptions): Required<Pick<WebsiteScanOptions, 'discoveryMethod' | 'maxPages'>> &
  WebsiteScanOptions {
  const maxPages = Math.min(options?.maxPages ?? defaultMaxPages(), MAX_WEBSITE_PAGES);
  return {
    ...options,
    discoveryMethod: options?.discoveryMethod ?? 'AUTOMATIC',
    maxPages,
  };
}
