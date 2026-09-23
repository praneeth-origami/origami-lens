import type {
  CreateScanRequest,
  Issue,
  IssueStatus,
  ScanListItem,
  ScanProgress,
  ScanResponse,
  ScanStatusResponse,
  ScanType,
  WebsiteScanOptions,
} from '@origami/contracts';
import { ScanRepository } from './db/scan-repository.js';
import { isDatabaseEnabled } from './db/pool.js';
import { ScanStore } from './scan-store.js';

export class UnifiedScanStore {
  private legacy = new ScanStore();
  private repo = new ScanRepository();

  saveScan(scan: ScanResponse): ScanResponse {
    this.legacy.saveScan(scan);
    if (this.repo.isEnabled()) {
      void this.repo.saveCurrentPageScan(scan);
    }
    return scan;
  }

  getScan(scanId: string): ScanResponse | undefined {
    return this.legacy.getScan(scanId);
  }

  async getScanAsync(scanId: string): Promise<ScanResponse | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getScan(scanId);
        if (fromDb) return fromDb;
      } catch (error) {
        // Postgres configured but unreachable (e.g. container restarting) —
        // degrade to the always-available legacy store instead of a 500.
        console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getScan(scanId);
  }

  /**
   * Deletes a scan (and, when Postgres is configured, everything cascaded
   * from it — page_scans/issues/issue_occurrences) but only if it belongs to
   * one of the caller's organizations. Removed from BOTH stores when both
   * are active, mirroring saveScan()'s dual-write, so the legacy mirror
   * never resurrects a scan the real store already deleted. Returns false
   * for "doesn't exist" and "exists but isn't yours" identically.
   */
  async deleteScanForOrganizationsAsync(scanId: string, organizationIds: string[]): Promise<boolean> {
    let deleted = false;
    if (this.repo.isEnabled()) {
      try {
        deleted = await this.repo.deleteScanForOrganizations(scanId, organizationIds);
      } catch (error) {
        console.error('[unified-scan-store] Postgres delete failed:', error instanceof Error ? error.message : error);
      }
    }
    const deletedFromLegacy = this.legacy.deleteScanForOrganizations(scanId, organizationIds);
    return deleted || deletedFromLegacy;
  }

  /** The authorization-aware lookup (UX audit follow-up) — filters at the SQL layer when Postgres is configured, so a scan belonging to another organization never leaves the database. Returns undefined for "doesn't exist" and "exists but isn't yours" identically. */
  async getScanForOrganizationsAsync(scanId: string, organizationIds: string[]): Promise<ScanResponse | undefined> {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getScanForOrganizations(scanId, organizationIds);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getScanForOrganizations(scanId, organizationIds);
  }

  listScans(): ScanListItem[] {
    return this.legacy.listScans();
  }

  async listScansAsync(): Promise<ScanListItem[]> {
    const legacy = this.legacy.listScans();
    if (!this.repo.isEnabled()) return legacy;

    try {
      const db = await this.repo.listScans();
      const ids = new Set(db.map((s) => s.scanId));
      const merged = [...db, ...legacy.filter((s) => !ids.has(s.scanId))];
      return merged.sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
    } catch (error) {
      console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      return legacy;
    }
  }

  /** The only listing a real, authenticated caller ever gets (UX audit follow-up) — always scoped to every organization they belong to, never an optional filter. */
  async listScansForOrganizationsAsync(organizationIds: string[]): Promise<ScanListItem[]> {
    const legacy = this.legacy.listScansForOrganizations(organizationIds);
    if (!this.repo.isEnabled()) return legacy;

    try {
      const db = await this.repo.listScansForOrganizations(organizationIds);
      const ids = new Set(db.map((s) => s.scanId));
      const merged = [...db, ...legacy.filter((s) => !ids.has(s.scanId))];
      return merged.sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
    } catch (error) {
      console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      return legacy;
    }
  }

  getIssue(issueId: string): { issue: Issue; scan: ScanResponse } | undefined {
    return this.legacy.getIssue(issueId);
  }

  async getIssueAsync(issueId: string) {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getIssue(issueId);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getIssue(issueId);
  }

  /** The authorization-aware lookup (UX audit follow-up) — an issue belongs to whichever scan found it, so ownership is checked via that scan's organization_id. */
  async getIssueForOrganizationsAsync(issueId: string, organizationIds: string[]) {
    if (this.repo.isEnabled()) {
      try {
        const fromDb = await this.repo.getIssueForOrganizations(issueId, organizationIds);
        if (fromDb) return fromDb;
      } catch (error) {
        console.error('[unified-scan-store] Postgres read failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.getIssueForOrganizations(issueId, organizationIds);
  }

  updateIssueStatus(issueId: string, status: IssueStatus): Issue | undefined {
    const updated = this.legacy.updateIssueStatus(issueId, status);
    if (this.repo.isEnabled()) {
      void this.repo.updateIssueStatus(issueId, status);
    }
    return updated;
  }

  /** Persists which repository a finding's AI fix/PR should target (migration 019) — same dual-write shape as updateIssueStatus, just a different field. Legacy write is authoritative for the return value; the Postgres write is fire-and-forget the same way updateIssueStatus's is. */
  async setIssueRepositoryAsync(issueId: string, repositoryId: string): Promise<Issue | undefined> {
    const updated = this.legacy.updateIssueRepository(issueId, repositoryId);
    if (this.repo.isEnabled()) {
      void this.repo.updateIssueRepository(issueId, repositoryId);
    }
    return updated;
  }

  /** The authorization-aware mutation (UX audit follow-up) — verifies the issue's scan belongs to one of the caller's organizations before writing anywhere. */
  async updateIssueStatusForOrganizationsAsync(issueId: string, status: IssueStatus, organizationIds: string[]): Promise<Issue | undefined> {
    if (this.repo.isEnabled()) {
      try {
        return await this.repo.updateIssueStatusForOrganizations(issueId, status, organizationIds);
      } catch (error) {
        console.error('[unified-scan-store] Postgres write failed, falling back to legacy store:', error instanceof Error ? error.message : error);
      }
    }
    return this.legacy.updateIssueStatusForOrganizations(issueId, status, organizationIds);
  }

  getRepository(): ScanRepository {
    return this.repo;
  }

  getLegacyStore(): ScanStore {
    return this.legacy;
  }

  databaseEnabled(): boolean {
    return isDatabaseEnabled();
  }
}

export type { CreateScanRequest, ScanType, WebsiteScanOptions, ScanStatusResponse, ScanProgress };
