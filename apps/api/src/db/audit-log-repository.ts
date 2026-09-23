import { randomUUID } from 'node:crypto';
import { getPool } from './pool.js';

export interface RecordAuditEventInput {
  actorUserId: string | undefined;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: string;
  actorUserId?: string;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * A minimal, generic audit trail (migration 028) — used ONLY at the
 * security-sensitive RBAC mutations called out in the RBAC design (platform-
 * role changes, workspace membership/role changes, ownership transfers,
 * Founder bootstrap), never as a general-purpose event bus. Best-effort:
 * failing to write an audit row must never block the underlying action it's
 * recording, so every caller wraps this in a caught, logged-and-ignored
 * failure rather than letting it fail the request.
 */
export class AuditLogRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async record(input: RecordAuditEventInput): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO audit_log (id, actor_user_id, event_type, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), input.actorUserId ?? null, input.eventType, input.targetType, input.targetId, JSON.stringify(input.metadata ?? {})],
    );
  }

  /** Feeds the admin dashboard's Recent Activity feed alongside job-completion events (see admin/activity-repository.ts) — the first read path this table has ever needed. */
  async listRecent(limit = 20): Promise<AuditLogEntry[]> {
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT id, actor_user_id, event_type, target_type, target_id, metadata, created_at
       FROM audit_log ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit, 100)],
    );
    return result.rows.map((row) => ({
      id: row.id as string,
      actorUserId: (row.actor_user_id as string) ?? undefined,
      eventType: row.event_type as string,
      targetType: row.target_type as string,
      targetId: row.target_id as string,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: (row.created_at as Date).toISOString(),
    }));
  }
}
