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

  updateIssueStatus(issueId: string, status: IssueStatus): Issue | undefined {
    const updated = this.legacy.updateIssueStatus(issueId, status);
    if (this.repo.isEnabled()) {
      void this.repo.updateIssueStatus(issueId, status);
    }
    return updated;
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
