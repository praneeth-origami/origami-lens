import { useEffect, useState } from 'react';
import { ApiRequestError, fetchBillingStatus, submitLead } from '../api/client';

interface Props {
  scanId?: string;
}

/**
 * "Talk to Origami" — a non-aggressive CTA shown after meaningful issues
 * are found (roadmap Phase 8). Deliberately understated copy, never
 * repeated sales pressure ("Hire us!" x3) — see the roadmap's own example.
 */
export function TalkToOrigamiCta({ scanId }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [isAgency, setIsAgency] = useState(false);
  const [isProspectAudit, setIsProspectAudit] = useState(false);

  // Agency plan (V4) — "lead audit report" entry point: an Agency user can
  // flag this submission as a deliberate prospective-client audit rather
  // than an organic sales inquiry (reuses the existing createLead/leads
  // table — see lead-service.ts's isProspectAudit gating, which silently
  // ignores this flag for any non-Agency organization anyway).
  useEffect(() => {
    fetchBillingStatus().then((status) => setIsAgency(status.subscription.plan === 'AGENCY')).catch(() => setIsAgency(false));
  }, []);

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      await submitLead({ name: name.trim(), email: email.trim(), company: company.trim() || undefined, message: message.trim() || undefined, scanId, isProspectAudit: isAgency ? isProspectAudit : undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not send this request — please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <section className="ai-section talk-to-origami-cta">
        <p className="ai-response">Thanks — an Origami engineer will follow up with you soon.</p>
      </section>
    );
  }

  return (
    <section className="ai-section talk-to-origami-cta">
      {!open ? (
        <div className="talk-to-origami-prompt">
          <div>
            <h3>Need help implementing these fixes?</h3>
            <p className="muted">Origami engineers can review your report.</p>
          </div>
          <button type="button" className="ghost-button" onClick={() => setOpen(true)}>Talk to Origami</button>
        </div>
      ) : (
        <>
          <h3>Talk to Origami</h3>
          <label className="github-issue-field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="github-issue-field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="github-issue-field">
            Company
            <input value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
          <label className="github-issue-field">
            Message
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
          </label>
          {isAgency && (
            <label className="monitoring-enable-toggle">
              <input type="checkbox" checked={isProspectAudit} onChange={(e) => setIsProspectAudit(e.target.checked)} />
              This is a lead audit for a prospective client
            </label>
          )}
          {error && <p className="ai-response ai-response-error">{error}</p>}
          <div className="confirm-dialog-actions">
            <button type="button" className="ghost-button" onClick={() => setOpen(false)} disabled={loading}>Cancel</button>
            <button type="button" className="primary-button" onClick={submit} disabled={loading || !name.trim() || !email.trim()}>
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
