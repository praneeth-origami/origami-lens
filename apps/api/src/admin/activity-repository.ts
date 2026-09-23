/**
 * The admin dashboard's cross-cutting read layer — direct SQL against every
 * existing job table (scans, component_jobs, repository_clone_jobs,
 * repository_index_jobs, repository_embedding_jobs, repository_issue_analyses,
 * repository_fix_proposals, repository_fix_workflows), never a parallel
 * tracking table. Kept as one cohesive module (not scattered "admin list"
 * methods bolted onto 8 different feature repositories) since every query
 * here is admin-only cross-organization reporting, structurally different
 * from every other repository's single-org-scoped methods.
 *
 * Every SELECT below names exact columns — never `evidence_json`,
 * `result_json`, `proposed_diff`, `diff`, or any credential/secret column —
 * so there is no code path here that can leak sensitive payloads into an
 * admin response.
 */
import type { AdminActivityItem, AdminActivityType, AdminSubscriptionBreakdown, AdminUsageTodayByPlan, SubscriptionPlan, SubscriptionStatus } from '@origami/contracts';
import { getPool } from '../db/pool.js';
import { currentUsageDate } from '../db/usage-counter-repository.js';

const ALL_PLANS: SubscriptionPlan[] = ['FREE', 'DEVELOPER', 'PRO', 'TEAM', 'AGENCY'];
const ALL_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING'];

const ACTIVE_LIMIT_PER_TABLE = 200;
const RECENT_LIMIT_PER_TABLE = 100;

export interface ActiveNowCounts {
  activeScans: number;
  activeAiJobs: number;
  activeRepositoryJobs: number;
  activeFixWorkflows: number;
}

/** Every count is a cheap, index-backed `COUNT(*) WHERE status IN (...)` — see migration 029's new status indexes. */
export async function countActiveNow(): Promise<ActiveNowCounts> {
  const pool = getPool();
  if (!pool) return { activeScans: 0, activeAiJobs: 0, activeRepositoryJobs: 0, activeFixWorkflows: 0 };

  const count = async (sql: string): Promise<number> => {
    const result = await pool.query(sql);
    return (result.rows[0]?.count as number) ?? 0;
  };

  const [scans, componentJobs, issueAnalyses, fixProposals, clone, index, embedding, fixWorkflows] = await Promise.all([
    count(`SELECT COUNT(*)::int AS count FROM scans WHERE status IN ('QUEUED','RUNNING')`),
    count(`SELECT COUNT(*)::int AS count FROM component_jobs WHERE status IN ('QUEUED','RUNNING','BLOCKED_PRIVACY')`),
    count(`SELECT COUNT(*)::int AS count FROM repository_issue_analyses WHERE status IN ('QUEUED','RUNNING')`),
    count(`SELECT COUNT(*)::int AS count FROM repository_fix_proposals WHERE status IN ('QUEUED','RUNNING')`),
    count(`SELECT COUNT(*)::int AS count FROM repository_clone_jobs WHERE status IN ('QUEUED','RUNNING')`),
    count(`SELECT COUNT(*)::int AS count FROM repository_index_jobs WHERE status IN ('QUEUED','RUNNING')`),
    count(`SELECT COUNT(*)::int AS count FROM repository_embedding_jobs WHERE status IN ('QUEUED','RUNNING')`),
    count(
      `SELECT COUNT(*)::int AS count FROM repository_fix_workflows WHERE status IN ('REVIEWABLE','APPROVED','BRANCH_CREATED','COMMITTED','PUSHED')`,
    ),
  ]);

  return {
    activeScans: scans,
    activeAiJobs: componentJobs + issueAnalyses + fixProposals,
    activeRepositoryJobs: clone + index + embedding,
    activeFixWorkflows: fixWorkflows,
  };
}

interface RawActivityRow {
  id: string;
  type: AdminActivityType;
  sub_type: string;
  organization_id: string | null;
  target_raw: string | null;
  status: string;
  started_at: Date;
  updated_at: Date;
}

/**
 * Every sub-select produces the identical column shape so they can UNION
 * ALL together. Tables with no `organization_id` of their own
 * (clone/index/embedding/fix_workflows — confirmed by this session's audit)
 * join through `repositories` for it; `repository_fix_workflows` also joins
 * to `issues` for a human title where one exists (finding_id references an
 * Issue.id from the website-scan feature, not enforced as a real FK since
 * the two features predate each other).
 */
function buildUnionSql(statusClause: (table: string) => string, perTableLimit: number): string {
  return `
    (SELECT id::text, 'SCAN'::text AS type, scan_type::text AS sub_type, organization_id, root_url AS target_raw,
            status::text, created_at AS started_at, updated_at
     FROM scans WHERE ${statusClause('scans')} ORDER BY updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT id::text, 'AI_JOB'::text, 'SCREENSHOT_TO_CODE'::text, organization_id, source_url,
            status::text, created_at, updated_at
     FROM component_jobs WHERE ${statusClause('component_jobs')} ORDER BY updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT ria.id::text, 'AI_JOB'::text, 'ISSUE_ANALYSIS'::text, r.organization_id, r.repo_url,
            ria.status::text, ria.created_at, ria.updated_at
     FROM repository_issue_analyses ria JOIN repositories r ON r.id = ria.repository_id
     WHERE ${statusClause('ria')} ORDER BY ria.updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT rfp.id::text, 'AI_JOB'::text, 'FIX_PROPOSAL'::text, r.organization_id, r.repo_url,
            rfp.status::text, rfp.created_at, rfp.updated_at
     FROM repository_fix_proposals rfp JOIN repositories r ON r.id = rfp.repository_id
     WHERE ${statusClause('rfp')} ORDER BY rfp.updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT rcj.id::text, 'REPOSITORY_JOB'::text, 'CLONE'::text, r.organization_id, r.repo_url,
            rcj.status::text, COALESCE(rcj.started_at, rcj.created_at), rcj.updated_at
     FROM repository_clone_jobs rcj JOIN repositories r ON r.id = rcj.repository_id
     WHERE ${statusClause('rcj')} ORDER BY rcj.updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT rij.id::text, 'REPOSITORY_JOB'::text, 'INDEX'::text, r.organization_id, r.repo_url,
            rij.status::text, COALESCE(rij.started_at, rij.created_at), rij.updated_at
     FROM repository_index_jobs rij JOIN repositories r ON r.id = rij.repository_id
     WHERE ${statusClause('rij')} ORDER BY rij.updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT rej.id::text, 'REPOSITORY_JOB'::text, 'EMBEDDING'::text, r.organization_id, r.repo_url,
            rej.status::text, COALESCE(rej.started_at, rej.created_at), rej.updated_at
     FROM repository_embedding_jobs rej JOIN repositories r ON r.id = rej.repository_id
     WHERE ${statusClause('rej')} ORDER BY rej.updated_at DESC LIMIT ${perTableLimit})
    UNION ALL
    (SELECT rfw.id::text, 'FIX_WORKFLOW'::text, rfw.status::text, r.organization_id,
            COALESCE(i.title, r.repo_url),
            rfw.status::text, rfw.created_at, rfw.updated_at
     FROM repository_fix_workflows rfw
     JOIN repositories r ON r.id = rfw.repository_id
     LEFT JOIN issues i ON i.id::text = rfw.finding_id
     WHERE ${statusClause('rfw')} ORDER BY rfw.updated_at DESC LIMIT ${perTableLimit})
  `;
}

const ACTIVE_STATUS_BY_TABLE: Record<string, string[]> = {
  scans: ['QUEUED', 'RUNNING'],
  component_jobs: ['QUEUED', 'RUNNING', 'BLOCKED_PRIVACY'],
  ria: ['QUEUED', 'RUNNING'],
  rfp: ['QUEUED', 'RUNNING'],
  rcj: ['QUEUED', 'RUNNING'],
  rij: ['QUEUED', 'RUNNING'],
  rej: ['QUEUED', 'RUNNING'],
  rfw: ['REVIEWABLE', 'APPROVED', 'BRANCH_CREATED', 'COMMITTED', 'PUSHED'],
};

const TERMINAL_STATUS_BY_TABLE: Record<string, string[]> = {
  scans: ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED'],
  component_jobs: ['COMPLETED', 'FAILED', 'CANCELLED'],
  ria: ['COMPLETED', 'FAILED', 'CANCELLED'],
  rfp: ['FIX_PROPOSED', 'APPROVED', 'REJECTED', 'FAILED'],
  rcj: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  rij: ['COMPLETED', 'FAILED', 'CANCELLED'],
  rej: ['COMPLETED', 'FAILED', 'CANCELLED'],
  rfw: ['PR_OPENED', 'FAILED', 'CANCELLED', 'EXPIRED'],
};

function inClause(statuses: Record<string, string[]>): (t: string) => string {
  return (t: string) => `${t}.status IN (${statuses[t].map((s) => `'${s}'`).join(',')})`;
}

/** Extracts a hostname when target_raw looks like a URL, otherwise falls back to the raw label (a repo display string, or an issue title) — never a full URL with query strings. */
function targetLabelFrom(raw: string | null): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

const SUB_TYPE_LABEL: Record<string, string> = {
  CURRENT_PAGE: 'Page scan',
  WEBSITE: 'Website scan',
  PROJECT: 'Project scan',
  SCREENSHOT_TO_CODE: 'Screenshot → Code',
  ISSUE_ANALYSIS: 'AI issue analysis',
  FIX_PROPOSAL: 'AI fix proposal',
  CLONE: 'Repository clone',
  INDEX: 'Repository index',
  EMBEDDING: 'Repository embeddings',
  REVIEWABLE: 'Fix workflow — awaiting review',
  APPROVED: 'Fix workflow — approved',
  BRANCH_CREATED: 'Fix workflow — creating branch',
  COMMITTED: 'Fix workflow — committing',
  PUSHED: 'Fix workflow — pushing',
  PR_OPENED: 'Fix workflow — PR created',
  FAILED: 'Fix workflow — failed',
  CANCELLED: 'Fix workflow — cancelled',
  EXPIRED: 'Fix workflow — expired',
};

function toActivityItem(row: RawActivityRow): AdminActivityItem {
  return {
    id: row.id,
    type: row.type,
    label: SUB_TYPE_LABEL[row.sub_type] ?? row.sub_type,
    status: row.status,
    organizationId: row.organization_id ?? undefined,
    targetLabel: targetLabelFrom(row.target_raw),
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ListActivityOptions {
  type?: AdminActivityType;
  status?: string;
  limit?: number;
}

/** "Active Now" / the Activity tab's live view — bounded per-table (never an unbounded scan of any one job table) and bounded again after the union. */
export async function listActiveActivity(options: ListActivityOptions = {}): Promise<AdminActivityItem[]> {
  const pool = getPool();
  if (!pool) return [];

  const sql = buildUnionSql(inClause(ACTIVE_STATUS_BY_TABLE), ACTIVE_LIMIT_PER_TABLE);
  const limit = Math.min(options.limit ?? 50, 200);
  const result = await pool.query<RawActivityRow>(
    `SELECT * FROM (${sql}) activity
     WHERE ($1::text IS NULL OR type = $1) AND ($2::text IS NULL OR status = $2)
     ORDER BY started_at DESC
     LIMIT $3`,
    [options.type ?? null, options.status ?? null, limit],
  );
  return result.rows.map(toActivityItem);
}

/** Subscription plan/status counts for the Overview tab and the Subscriptions section — a straight GROUP BY, no per-organization loop. */
export async function countSubscriptionsByPlanAndStatus(): Promise<AdminSubscriptionBreakdown> {
  const byPlan = Object.fromEntries(ALL_PLANS.map((p) => [p, 0])) as Record<SubscriptionPlan, number>;
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<SubscriptionStatus, number>;

  const pool = getPool();
  if (!pool) return { byPlan, byStatus };

  const [planRows, statusRows] = await Promise.all([
    pool.query(`SELECT plan, COUNT(*)::int AS count FROM subscriptions GROUP BY plan`),
    pool.query(`SELECT status, COUNT(*)::int AS count FROM subscriptions GROUP BY status`),
  ]);
  for (const row of planRows.rows) byPlan[row.plan as SubscriptionPlan] = row.count as number;
  for (const row of statusRows.rows) byStatus[row.status as SubscriptionStatus] = row.count as number;
  return { byPlan, byStatus };
}

/** Today's real usage_counters rows (migration 025), summed by plan — never derived/estimated. `currentUsageDate()` is the exact same UTC-day helper billing/usage-counter-repository.ts itself writes with, so this always matches what was actually recorded, regardless of the Postgres server's own timezone setting. */
export async function sumUsageTodayByPlan(): Promise<AdminUsageTodayByPlan[]> {
  const byPlan = new Map<SubscriptionPlan, AdminUsageTodayByPlan>(
    ALL_PLANS.map((plan) => [plan, { plan, inspections: 0, aiQuestions: 0, screenshotToCode: 0 }]),
  );

  const pool = getPool();
  if (!pool) return [...byPlan.values()];

  const result = await pool.query(
    `SELECT s.plan, uc.metric, SUM(uc.count)::int AS total
     FROM usage_counters uc
     JOIN subscriptions s ON s.organization_id = uc.organization_id
     WHERE uc.usage_date = $1
     GROUP BY s.plan, uc.metric`,
    [currentUsageDate()],
  );

  for (const row of result.rows) {
    const entry = byPlan.get(row.plan as SubscriptionPlan);
    if (!entry) continue;
    if (row.metric === 'INSPECTION') entry.inspections = row.total as number;
    else if (row.metric === 'AI_QUESTION') entry.aiQuestions = row.total as number;
    else if (row.metric === 'SCREENSHOT_TO_CODE') entry.screenshotToCode = row.total as number;
  }
  return [...byPlan.values()];
}

/** Recent Activity feed — terminal-state rows updated within the last 24 hours, explicitly time-bounded per the spec's own "bounded time ranges" performance requirement. */
export async function listRecentActivity(limit = 20): Promise<AdminActivityItem[]> {
  const pool = getPool();
  if (!pool) return [];

  const statusClause = inClause(TERMINAL_STATUS_BY_TABLE);
  const timeClause = (t: string) => `${statusClause(t)} AND ${t}.updated_at > NOW() - INTERVAL '24 hours'`;
  const sql = buildUnionSql(timeClause, RECENT_LIMIT_PER_TABLE);
  const boundedLimit = Math.min(limit, 100);
  const result = await pool.query<RawActivityRow>(`SELECT * FROM (${sql}) activity ORDER BY updated_at DESC LIMIT $1`, [boundedLimit]);
  return result.rows.map(toActivityItem);
}
