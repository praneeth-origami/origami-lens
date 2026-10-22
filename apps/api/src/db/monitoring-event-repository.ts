import type { MonitoringEvent, MonitoringEventType, Severity } from '@origami/contracts';
import { randomUUID } from 'node:crypto';
import { getPool } from './pool.js';

export interface CreateMonitoringEventInput {
  monitoredSiteId: string;
  scanId?: string;
  previousScanId?: string;
  eventType: MonitoringEventType;
  severity: Severity;
  title: string;
  description: string;
  previousValue?: unknown;
  currentValue?: unknown;
  metadata?: Record<string, unknown>;
}

interface MonitoringEventRow {
  id: string;
  monitored_site_id: string;
  scan_id: string | null;
  previous_scan_id: string | null;
  event_type: MonitoringEventType;
  severity: Severity;
  title: string;
  description: string;
  previous_value: unknown;
  current_value: unknown;
  metadata: Record<string, unknown>;
  deployment_id: string | null;
  commit_sha: string | null;
  repository_id: string | null;
  created_at: Date;
}

function rowToEvent(row: MonitoringEventRow): MonitoringEvent {
  return {
    id: row.id,
    monitoredSiteId: row.monitored_site_id,
    scanId: row.scan_id ?? undefined,
    previousScanId: row.previous_scan_id ?? undefined,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    description: row.description,
    previousValue: row.previous_value ?? undefined,
    currentValue: row.current_value ?? undefined,
    metadata: row.metadata ?? {},
    deploymentId: row.deployment_id ?? undefined,
    commitSha: row.commit_sha ?? undefined,
    repositoryId: row.repository_id ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export class MonitoringEventRepository {
  async createMany(events: CreateMonitoringEventInput[]): Promise<MonitoringEvent[]> {
    if (events.length === 0) return [];
    const pool = getPool();
    if (!pool) return [];
    const created: MonitoringEvent[] = [];
    // One INSERT per event rather than a multi-row statement — regression
    // counts per scan are always small (single digits), and this keeps the
    // parameter-binding simple; see entitlement-service.ts for where a
    // genuinely hot path in this codebase DOES batch instead.
    for (const event of events) {
      const result = await pool.query<MonitoringEventRow>(
        `INSERT INTO monitoring_events (id, monitored_site_id, scan_id, previous_scan_id, event_type, severity, title, description, previous_value, current_value, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          randomUUID(),
          event.monitoredSiteId,
          event.scanId ?? null,
          event.previousScanId ?? null,
          event.eventType,
          event.severity,
          event.title,
          event.description,
          event.previousValue !== undefined ? JSON.stringify(event.previousValue) : null,
          event.currentValue !== undefined ? JSON.stringify(event.currentValue) : null,
          JSON.stringify(event.metadata ?? {}),
        ],
      );
      created.push(rowToEvent(result.rows[0]));
    }
    return created;
  }

  async listForMonitoredSite(monitoredSiteId: string, limit = 50): Promise<MonitoringEvent[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query<MonitoringEventRow>(
      `SELECT * FROM monitoring_events WHERE monitored_site_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [monitoredSiteId, limit],
    );
    return result.rows.map(rowToEvent);
  }

  /** Every event produced by the single most recent scan — "is the site currently in regression" is exactly "does this list have any rows" (see monitored-site-service.ts). */
  async listForScan(scanId: string): Promise<MonitoringEvent[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query<MonitoringEventRow>(`SELECT * FROM monitoring_events WHERE scan_id = $1 ORDER BY created_at`, [scanId]);
    return result.rows.map(rowToEvent);
  }

  async markNotified(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE monitoring_events SET notified_at = NOW() WHERE id = ANY($1::uuid[])`, [ids]);
  }
}
