-- Workspace email invitations. Membership is created ONLY on explicit
-- acceptance (workspace-invitation-service.ts) — this table exists so the
-- pending state, the secure token, and the audit trail (invitations are
-- never deleted, only status-transitioned) all survive independently of
-- organization_memberships. See workspace-invitation-repository.ts.

DO $$ BEGIN
  CREATE TYPE workspace_invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role organization_role NOT NULL,
  token_hash TEXT NOT NULL,
  status workspace_invitation_status NOT NULL DEFAULT 'PENDING',
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_org ON workspace_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email ON workspace_invitations(invited_email);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_status ON workspace_invitations(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitations_token_hash ON workspace_invitations(token_hash);

-- Only one active invitation per workspace/email at a time — enforced here
-- (not just in application code) so a race between two concurrent "invite"
-- requests can never leave two PENDING rows for the same org/email.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_invitations_pending_org_email
  ON workspace_invitations(organization_id, invited_email) WHERE status = 'PENDING';
