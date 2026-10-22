import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AgencyBranding, ClientWorkspaceSummary } from '@origami/contracts';
import {
  ApiRequestError,
  createClientWorkspace,
  fetchAgencyBranding,
  fetchBillingStatus,
  fetchClientWorkspaces,
  switchWorkspace,
  updateAgencyBranding,
  uploadAgencyLogo,
} from '../api/client';
import { ErrorState, LoadingSkeleton } from '../components/StateViews';
import { CrownIcon, PaletteIcon, UsersIcon, GlobeIcon } from '../components/icons';
import { lensEvent } from '../notifications/lens-event';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function UpgradePrompt() {
  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><CrownIcon /> Agency</div>
          <h1 className="page-title">Continuous Website Monitoring for Agencies</h1>
          <p className="page-subtitle">Client workspaces, white-label reports, and lead audits are available on the Agency plan.</p>
        </div>
      </div>
      <div className="empty-state-card">
        <span className="empty-state-icon" aria-hidden="true"><CrownIcon /></span>
        <h3>Upgrade to Agency</h3>
        <p>Manage up to 15 team members, unlimited client workspaces, and white-labeled reports.</p>
        <Link to="/pricing" className="primary-button">View Plans</Link>
      </div>
    </div>
  );
}

function ClientWorkspacesSection({ clients, onCreated }: { clients: ClientWorkspaceSummary[]; onCreated: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !name.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const workspace = await createClientWorkspace({ name: name.trim() });
      lensEvent.success('Client workspace created', { resource: workspace.name });
      setName('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the client workspace.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSwitch = async (organizationId: string) => {
    await switchWorkspace({ organizationId });
    window.location.reload();
  };

  return (
    <article className="detail-card">
      <div className="ai-section-heading">
        <div>
          <h3><UsersIcon /> Client Workspaces</h3>
          <p className="muted">Each client gets a fully isolated workspace — projects, scans, and reports never cross between clients.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : '+ Add Client'}</button>
      </div>

      {open && (
        <form className="connect-repo-form" onSubmit={(e) => void handleCreate(e)}>
          <div className="connect-repo-field">
            <label htmlFor="client-name">Client name</label>
            <input id="client-name" className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required />
          </div>
          {error && <p className="connect-repo-error" role="alert">{error}</p>}
          <div className="confirm-dialog-actions">
            <button type="submit" className="primary-button" disabled={submitting || !name.trim()}>{submitting ? 'Creating…' : 'Create Workspace'}</button>
          </div>
        </form>
      )}

      {clients.length === 0 ? (
        <p className="muted">No client workspaces yet.</p>
      ) : (
        <div className="record-table-wrap">
          <table className="record-table">
            <thead><tr><th>Client</th><th>Members</th><th>Created</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.organizationId}>
                  <td data-label="Client">{client.name}</td>
                  <td data-label="Members">{client.memberCount}</td>
                  <td data-label="Created">{new Date(client.createdAt).toLocaleDateString()}</td>
                  <td data-label="Actions">
                    <button type="button" className="ghost-button" onClick={() => void handleSwitch(client.organizationId)}>Switch to workspace</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="ghost-button" onClick={() => navigate('/scans')} style={{ marginTop: 12 }}>Run a Lead Audit →</button>
    </article>
  );
}

function BrandingSection({ branding, onUpdated }: { branding: AgencyBranding; onUpdated: (b: AgencyBranding) => void }) {
  const [displayName, setDisplayName] = useState(branding.displayName ?? '');
  const [primaryColor, setPrimaryColor] = useState(branding.primaryColor ?? '#6d5ef6');
  const [websiteUrl, setWebsiteUrl] = useState(branding.websiteUrl ?? '');
  const [contactEmail, setContactEmail] = useState(branding.contactEmail ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const updated = await updateAgencyBranding({ displayName: displayName.trim() || undefined, primaryColor, websiteUrl: websiteUrl.trim() || undefined, contactEmail: contactEmail.trim() || undefined });
      onUpdated(updated);
      lensEvent.success('Branding saved');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save branding.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const base64 = await fileToBase64(file);
      const updated = await uploadAgencyLogo(file.type, base64);
      onUpdated(updated);
      lensEvent.success('Logo uploaded');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the logo.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <article className="detail-card">
      <div className="ai-section-heading">
        <div>
          <h3><PaletteIcon /> Custom Branding</h3>
          <p className="muted">Applied to white-labeled client reports and share links.</p>
        </div>
      </div>

      <label className="github-issue-field">
        Agency Display Name
        <input className="search-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme Agency" />
      </label>
      <label className="github-issue-field">
        Primary Brand Color
        <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} style={{ width: 60, height: 36 }} />
      </label>
      <label className="github-issue-field">
        Website URL
        <input className="search-input" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://acme.example" />
      </label>
      <label className="github-issue-field">
        Contact Email
        <input className="search-input" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="hello@acme.example" />
      </label>
      <label className="github-issue-field">
        Logo (PNG or JPEG, max 2MB)
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" onChange={(e) => void handleLogoChange(e)} disabled={uploading} />
      </label>

      {error && <p className="connect-repo-error" role="alert">{error}</p>}

      <div className="confirm-dialog-actions">
        <button type="button" className="primary-button" disabled={saving} onClick={() => void handleSave()}>{saving ? 'Saving…' : 'Save Branding'}</button>
      </div>

      <div className="detail-card" style={{ marginTop: 16, background: 'var(--surface-2)' }}>
        <p className="muted" style={{ marginBottom: 8 }}>Report preview</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {branding.logoUrl ? <img src={`/api${branding.logoUrl}`} alt="Logo" style={{ height: 28 }} /> : <GlobeIcon />}
          <strong style={{ color: primaryColor }}>{displayName || 'Your Agency Name'}</strong>
        </div>
      </div>
    </article>
  );
}

export function AgencyPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAgency, setIsAgency] = useState(false);
  const [clients, setClients] = useState<ClientWorkspaceSummary[]>([]);
  const [branding, setBranding] = useState<AgencyBranding | null>(null);

  const load = () => {
    setLoading(true);
    fetchBillingStatus()
      .then(async (status) => {
        const agency = status.subscription.plan === 'AGENCY';
        setIsAgency(agency);
        if (agency) {
          const [clientsRes, brandingRes] = await Promise.all([fetchClientWorkspaces(), fetchAgencyBranding()]);
          setClients(clientsRes.clients);
          setBranding(brandingRes);
        }
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load Agency settings'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <div className="dashboard"><LoadingSkeleton /></div>;
  if (error) return <div className="dashboard"><ErrorState message={error} onRetry={load} /></div>;
  if (!isAgency) return <UpgradePrompt />;

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row workspace-heading-row">
        <div>
          <div className="page-eyebrow"><CrownIcon /> Agency</div>
          <h1 className="page-title">{branding?.displayName || 'Agency Workspace'}</h1>
          <p className="page-subtitle">Manage client workspaces, branding, and lead audits.</p>
        </div>
      </div>

      <div className="repo-summary-row">
        <div className="repo-summary-grid">
          <div className="repo-summary-tile">
            <span className="repo-summary-tile-icon total" aria-hidden="true"><UsersIcon /></span>
            <div>
              <span className="repo-summary-tile-count">{clients.length}</span>
              <span className="repo-summary-tile-label">Client Workspaces</span>
            </div>
          </div>
        </div>
      </div>

      <ClientWorkspacesSection clients={clients} onCreated={load} />
      {branding && <BrandingSection branding={branding} onUpdated={setBranding} />}
    </div>
  );
}
