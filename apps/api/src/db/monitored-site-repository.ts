import type { MonitoredSite, MonitoringFrequency, MonitoringSiteStatus } from '@origami/contracts';
import { getPool } from './pool.js';

export interface CreateMonitoredSiteInput {
  id: string;
  organizationId: string;
  name: string;
  url: string;
  frequency: MonitoringFrequency;
  enabled: boolean;
  createdByUserId?: string;
  nextScanAt: string;
}

interface MonitoredSiteRow {
  id: string;
  organization_id: string;
  name: string;
  url: string;
  enabled: boolean;
  frequency: MonitoringFrequency;
  status: MonitoringSiteStatus;
  baseline_scan_id: string | null;
  last_scan_id: string | null;
  last_scan_at: Date | null;
  last_scan_error: string | null;
  next_scan_at: Date;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToMonitoredSite(row: MonitoredSiteRow): MonitoredSite {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    frequency: row.frequency,
    status: row.status,
    baselineScanId: row.baseline_scan_id ?? undefined,
    lastScanId: row.last_scan_id ?? undefined,
    lastScanAt: row.last_scan_at ? row.last_scan_at.toISOString() : undefined,
    lastScanError: row.last_scan_error ?? undefined,
    nextScanAt: row.next_scan_at.toISOString(),
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class MonitoredSiteRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateMonitoredSiteInput): Promise<MonitoredSite> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query<MonitoredSiteRow>(
      `INSERT INTO monitored_sites (id, organization_id, name, url, enabled, frequency, created_by_user_id, next_scan_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.id, input.organizationId, input.name, input.url, input.enabled, input.frequency, input.createdByUserId ?? null, input.nextScanAt],
    );
    return rowToMonitoredSite(result.rows[0]);
  }

  /** Unscoped lookup for internal/trusted callers only (the worker's post-scan completion hook, which already knows the monitoredSiteId from its own job payload) — never expose this path to an HTTP route; every caller-facing read must go through getForOrganizations instead. */
  async getById(id: string): Promise<MonitoredSite | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<MonitoredSiteRow>(`SELECT * FROM monitored_sites WHERE id = $1`, [id]);
    if (result.rows.length === 0) return undefined;
    return rowToMonitoredSite(result.rows[0]);
  }

  async getForOrganizations(id: string, organizationIds: string[]): Promise<MonitoredSite | undefined> {
    if (organizationIds.length === 0) return undefined;
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<MonitoredSiteRow>(
      `SELECT * FROM monitored_sites WHERE id = $1 AND organization_id = ANY($2::uuid[])`,
      [id, organizationIds],
    );
    if (result.rows.length === 0) return undefined;
    return rowToMonitoredSite(result.rows[0]);
  }

  async listForOrganizations(organizationIds: string[]): Promise<MonitoredSite[]> {
    if (organizationIds.length === 0) return [];
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query<MonitoredSiteRow>(
      `SELECT * FROM monitored_sites WHERE organization_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
      [organizationIds],
    );
    return result.rows.map(rowToMonitoredSite);
  }

  async countEnabledForOrganization(organizationId: string): Promise<number> {
    const pool = getPool();
    if (!pool) return 0;
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM monitored_sites WHERE organization_id = $1 AND enabled = true`, [organizationId]);
    return result.rows[0]?.count ?? 0;
  }

  async updateConfig(id: string, patch: { name?: string; frequency?: MonitoringFrequency }): Promise<MonitoredSite | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<MonitoredSiteRow>(
      `UPDATE monitored_sites SET name = COALESCE($2, name), frequency = COALESCE($3, frequency), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.frequency ?? null],
    );
    if (result.rows.length === 0) return undefined;
    return rowToMonitoredSite(result.rows[0]);
  }

  async setEnabled(id: string, enabled: boolean, nextScanAt?: string): Promise<MonitoredSite | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<MonitoredSiteRow>(
      `UPDATE monitored_sites SET enabled = $2, next_scan_at = COALESCE($3, next_scan_at), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, enabled, nextScanAt ?? null],
    );
    if (result.rows.length === 0) return undefined;
    return rowToMonitoredSite(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const pool = getPool();
    if (!pool) return false;
    const result = await pool.query(`DELETE FROM monitored_sites WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomically claims every monitored site due for a scan right now — the
   * scheduler sweep's core idempotency primitive (same "claim via a single
   * UPDATE...RETURNING" shape as subscription-repository.ts's
   * claimExpiringSoonNotification). Advancing next_scan_at IMMEDIATELY
   * (before the scan even runs) is what makes this safe across overlapping
   * sweep ticks and worker-process restarts: a site claimed here will not
   * be claimed again by a concurrent/later tick even if the scan itself
   * takes a long time or the process restarts mid-scan. If the scan
   * attempt fails, recordScanFailure still leaves next_scan_at advanced
   * (monitoring resumes on the next normal cycle rather than retrying in a
   * tight loop).
   */
  async claimDueSites(limit = 25): Promise<MonitoredSite[]> {
    const pool = getPool();
    if (!pool) return [];
    // CASE has one branch today (only DAILY exists) — add a WHEN here when a
    // second MonitoringFrequency value ships, never a parallel code path.
    const result = await pool.query<MonitoredSiteRow>(
      `UPDATE monitored_sites
       SET next_scan_at = next_scan_at + (CASE frequency WHEN 'DAILY' THEN INTERVAL '1 day' END), updated_at = NOW()
       WHERE id IN (
         SELECT id FROM monitored_sites
         WHERE enabled = true AND next_scan_at <= NOW()
         ORDER BY next_scan_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit],
    );
    return result.rows.map(rowToMonitoredSite);
  }

  async recordScanQueued(id: string, scanId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE monitored_sites SET last_scan_id = $2, updated_at = NOW() WHERE id = $1`, [id, scanId]);
  }

  async recordScanSuccess(id: string, params: { scanId: string; scannedAt: string; status: MonitoringSiteStatus; setBaselineIfUnset: boolean }): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    if (params.setBaselineIfUnset) {
      await pool.query(
        `UPDATE monitored_sites
         SET last_scan_id = $2, last_scan_at = $3, last_scan_error = NULL, status = $4,
             baseline_scan_id = COALESCE(baseline_scan_id, $2), updated_at = NOW()
         WHERE id = $1`,
        [id, params.scanId, params.scannedAt, params.status],
      );
    } else {
      await pool.query(
        `UPDATE monitored_sites SET last_scan_id = $2, last_scan_at = $3, last_scan_error = NULL, status = $4, updated_at = NOW() WHERE id = $1`,
        [id, params.scanId, params.scannedAt, params.status],
      );
    }
  }

  async recordScanFailure(id: string, scanId: string, error: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `UPDATE monitored_sites SET last_scan_id = $2, last_scan_error = $3, status = 'FAILED', updated_at = NOW() WHERE id = $1`,
      [id, scanId, error],
    );
  }
}
