import type { AgencyBranding } from '@origami/contracts';
import { getPool } from './pool.js';

interface AgencyBrandingRow {
  organization_id: string;
  display_name: string | null;
  logo_storage_key: string | null;
  primary_color: string | null;
  accent_color: string | null;
  website_url: string | null;
  contact_email: string | null;
  updated_at: Date;
}

function rowToBranding(row: AgencyBrandingRow, logoUrl: (storageKey: string) => string): AgencyBranding {
  return {
    organizationId: row.organization_id,
    displayName: row.display_name ?? undefined,
    logoUrl: row.logo_storage_key ? logoUrl(row.logo_storage_key) : undefined,
    primaryColor: row.primary_color ?? undefined,
    accentColor: row.accent_color ?? undefined,
    websiteUrl: row.website_url ?? undefined,
    contactEmail: row.contact_email ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface UpdateAgencyBrandingInput {
  displayName?: string;
  primaryColor?: string;
  accentColor?: string;
  websiteUrl?: string;
  contactEmail?: string;
}

/** Postgres-backed store for `agency_branding` (migration 042) — one row per organization, upserted in place (never a history of past branding). */
export class AgencyBrandingRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async get(organizationId: string, logoUrl: (storageKey: string) => string): Promise<AgencyBranding | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<AgencyBrandingRow>(`SELECT * FROM agency_branding WHERE organization_id = $1`, [organizationId]);
    if (result.rows.length === 0) return undefined;
    return rowToBranding(result.rows[0], logoUrl);
  }

  async upsert(organizationId: string, input: UpdateAgencyBrandingInput, logoUrl: (storageKey: string) => string): Promise<AgencyBranding> {
    const pool = getPool();
    if (!pool) throw new Error('Database not configured');
    const result = await pool.query<AgencyBrandingRow>(
      `INSERT INTO agency_branding (organization_id, display_name, primary_color, accent_color, website_url, contact_email)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, agency_branding.display_name),
         primary_color = COALESCE(EXCLUDED.primary_color, agency_branding.primary_color),
         accent_color = COALESCE(EXCLUDED.accent_color, agency_branding.accent_color),
         website_url = COALESCE(EXCLUDED.website_url, agency_branding.website_url),
         contact_email = COALESCE(EXCLUDED.contact_email, agency_branding.contact_email),
         updated_at = NOW()
       RETURNING *`,
      [organizationId, input.displayName ?? null, input.primaryColor ?? null, input.accentColor ?? null, input.websiteUrl ?? null, input.contactEmail ?? null],
    );
    return rowToBranding(result.rows[0], logoUrl);
  }

  async setLogoStorageKey(organizationId: string, storageKey: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO agency_branding (organization_id, logo_storage_key) VALUES ($1, $2)
       ON CONFLICT (organization_id) DO UPDATE SET logo_storage_key = EXCLUDED.logo_storage_key, updated_at = NOW()`,
      [organizationId, storageKey],
    );
  }

  /** Internal accessor (no logoUrl resolution) — used by report-service.ts to decide whether a storage key exists without needing a URL builder. */
  async getRaw(organizationId: string): Promise<{ displayName?: string; logoStorageKey?: string; primaryColor?: string } | undefined> {
    const pool = getPool();
    if (!pool) return undefined;
    const result = await pool.query<AgencyBrandingRow>(`SELECT * FROM agency_branding WHERE organization_id = $1`, [organizationId]);
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return { displayName: row.display_name ?? undefined, logoStorageKey: row.logo_storage_key ?? undefined, primaryColor: row.primary_color ?? undefined };
  }
}
