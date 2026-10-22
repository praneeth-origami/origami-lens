import { getPool } from './pool.js';

export interface CreateLeadInput {
  id: string;
  organizationId?: string;
  scanId?: string;
  name: string;
  email: string;
  company?: string;
  message?: string;
  domain?: string;
  healthScore?: number;
  issueSummary?: { critical: number; important: number; improvements: number };
  /** Agency plan (V4) — distinguishes a deliberate "audit this prospect's site, then share the report" lead from the pre-existing organic "Talk to Origami" sales contact-form submission (migration 042). Both are still just rows in this same table. */
  isProspectAudit?: boolean;
}

/** Origami Lead Generation (roadmap Phase 8, migration 037) — write-only from this application's own routes; reading leads back is an internal/CRM concern outside this pass's scope (see lead-service.ts's doc comment). */
export class LeadRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async create(input: CreateLeadInput): Promise<void> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    await pool.query(
      `INSERT INTO leads (id, organization_id, scan_id, name, email, company, message, domain, health_score, issue_summary_json, is_prospect_audit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.id,
        input.organizationId ?? null,
        input.scanId ?? null,
        input.name,
        input.email,
        input.company ?? null,
        input.message ?? null,
        input.domain ?? null,
        input.healthScore ?? null,
        input.issueSummary ? JSON.stringify(input.issueSummary) : null,
        input.isProspectAudit ?? false,
      ],
    );
  }
}
