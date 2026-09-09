import type { CodeTarget, ComponentEvidence, ComponentGenerationJob, ComponentGenerationStatus, ComponentJobListItem, GenerationErrorCategory } from '@origami/contracts';
import { getPool } from './pool.js';

interface CreateComponentJobInput {
  jobId: string;
  ownerId?: string;
  sourceUrl: string;
  pageTitle?: string;
  target: CodeTarget;
}

export class ComponentRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async createJob(input: CreateComponentJobInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');

    await pool.query(
      `INSERT INTO component_jobs (id, owner_id, source_url, page_title, target, status)
       VALUES ($1, $2, $3, $4, $5, 'QUEUED')`,
      [input.jobId, input.ownerId ?? null, input.sourceUrl, input.pageTitle ?? null, input.target],
    );
  }

  async saveEvidence(jobId: string, evidence: ComponentEvidence): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE component_jobs SET evidence_json = $2 WHERE id = $1`, [jobId, JSON.stringify(evidence)]);
  }

  async getEvidence(jobId: string): Promise<ComponentEvidence | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query(`SELECT evidence_json FROM component_jobs WHERE id = $1`, [jobId]);
    return result.rows[0]?.evidence_json ?? undefined;
  }

  async updateStatus(jobId: string, status: ComponentGenerationStatus, error?: string, errorCategory?: GenerationErrorCategory): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE component_jobs SET status = $2, error = $3, error_category = $4, updated_at = NOW() WHERE id = $1`,
      [jobId, status, error ?? null, errorCategory ?? null],
    );
  }

  async completeJob(
    jobId: string,
    data: {
      status: ComponentGenerationStatus;
      componentName?: string;
      result?: object;
      verification?: object;
      aiAvailable: boolean;
      error?: string;
      errorCategory?: GenerationErrorCategory;
    },
  ): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    await pool.query(
      `UPDATE component_jobs SET status = $2, component_name = $3, result_json = $4,
       verification_json = $5, ai_available = $6, error = $7, error_category = $8, updated_at = NOW()
       WHERE id = $1`,
      [
        jobId,
        data.status,
        data.componentName ?? null,
        data.result ? JSON.stringify(data.result) : null,
        data.verification ? JSON.stringify(data.verification) : null,
        data.aiAvailable,
        data.error ?? null,
        data.errorCategory ?? null,
      ],
    );
  }

  async getJob(jobId: string): Promise<ComponentGenerationJob | undefined> {
    const pool = getPool();
    if (!pool) return undefined;

    const result = await pool.query(`SELECT * FROM component_jobs WHERE id = $1`, [jobId]);
    if (result.rows.length === 0) return undefined;
    return this.rowToJob(result.rows[0]);
  }

  async listJobs(ownerId?: string): Promise<ComponentJobListItem[]> {
    const pool = getPool();
    if (!pool) return [];

    const result = ownerId
      ? await pool.query(
          `SELECT id, source_url, component_name, target, status, created_at FROM component_jobs
           WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [ownerId],
        )
      : await pool.query(
          `SELECT id, source_url, component_name, target, status, created_at FROM component_jobs
           ORDER BY created_at DESC LIMIT 100`,
        );

    return result.rows.map((row) => ({
      jobId: row.id,
      sourceUrl: row.source_url,
      componentName: row.component_name ?? undefined,
      target: row.target,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  private rowToJob(row: Record<string, unknown>): ComponentGenerationJob {
    return {
      jobId: row.id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      sourceUrl: row.source_url as string,
      pageTitle: (row.page_title as string) ?? undefined,
      target: row.target as CodeTarget,
      status: row.status as ComponentGenerationStatus,
      error: (row.error as string) ?? undefined,
      errorCategory: (row.error_category as GenerationErrorCategory) ?? undefined,
      result: (row.result_json as ComponentGenerationJob['result']) ?? undefined,
      verification: (row.verification_json as ComponentGenerationJob['verification']) ?? undefined,
      aiAvailable: Boolean(row.ai_available),
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}
