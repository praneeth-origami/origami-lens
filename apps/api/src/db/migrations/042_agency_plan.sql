-- Agency Plan (V4) — client workspaces, white-label branding, client share
-- link expiration, and lead-audit tracking. Deliberately reuses the
-- existing `organizations` table AS the client-workspace entity (full
-- existing tenant isolation — organization_id scoping on every resource —
-- already applies automatically), rather than inventing a parallel
-- workspace concept. See the Agency implementation report for the full
-- audit this was based on.

-- A client workspace is an ordinary organization with a non-null
-- parent_organization_id pointing at the agency that created it. This is a
-- LISTING/management relationship only — it does NOT by itself grant any
-- agency member access to the client workspace's data; access is still
-- governed entirely by that organization's own organization_memberships
-- rows, exactly like any other organization. ON DELETE SET NULL (not
-- CASCADE): deleting an agency organization must never delete its clients'
-- own independent workspaces/data.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS parent_organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_organizations_parent_organization_id ON organizations(parent_organization_id);

-- White-label branding (Agency plan). One row per organization; branding is
-- only actually APPLIED to a report if that organization's current plan
-- entitlement allows it (EntitlementService.canUseWhiteLabelBranding) even
-- if a row exists here from a since-downgraded account — never enforced by
-- this table's mere existence.
CREATE TABLE IF NOT EXISTS agency_branding (
  organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT,
  logo_storage_key TEXT,
  primary_color TEXT,
  accent_color TEXT,
  website_url TEXT,
  contact_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client share links (reuses the existing report_share_links mechanism —
-- migration 035 — rather than a second sharing system). The only genuinely
-- missing piece per the audit: optional expiration. NULL preserves every
-- existing link's current "valid until revoked" behavior exactly.
ALTER TABLE report_share_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Lead audit reports (Agency plan) — reuses the existing `leads` table
-- (migration 037) as the "prospective-client record" the requirements doc
-- asks for, rather than a new CRM entity. is_prospect_audit distinguishes
-- an agency's deliberate "audit this prospect's site, then share the
-- report" flow from the pre-existing organic "Talk to Origami" sales
-- contact-form submission — both still just rows in the same table.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_prospect_audit BOOLEAN NOT NULL DEFAULT FALSE;
