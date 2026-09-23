import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import { useBillingStatus } from '../hooks/useBillingStatus';
import { useWorkspaceRole } from '../hooks/useWorkspaceRole';
import { canManageBilling } from '../utils/workspace-permissions';
import { createBillingPortalSession, updateSeats, ApiRequestError } from '../api/client';
import { lensEvent } from '../notifications/lens-event';

const METRIC_LABEL: Record<string, string> = {
  INSPECTION: 'Inspections',
  AI_QUESTION: 'AI questions',
  SCREENSHOT_TO_CODE: 'Screenshot → Code',
};

export function BillingSettingsPage() {
  const { status, loading, error, refresh } = useBillingStatus();
  const { role, loading: roleLoading } = useWorkspaceRole();
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [seatInput, setSeatInput] = useState<number | null>(null);
  const [seatSaving, setSeatSaving] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);

  const handleManageBilling = async () => {
    setPortalError(null);
    setPortalLoading(true);
    try {
      const { url } = await createBillingPortalSession();
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'BILLING_NOT_CONFIGURED') {
        setPortalError('Billing is not configured on this server yet.');
      } else if (err instanceof ApiRequestError && err.code === 'ORGANIZATION_NOT_FOUND') {
        setPortalError('You have no billing account yet — choose a paid plan first.');
      } else {
        setPortalError(err instanceof Error ? err.message : 'Could not open the billing portal.');
      }
      setPortalLoading(false);
    }
  };

  const handleSaveSeats = async () => {
    if (seatInput === null) return;
    setSeatSaving(true);
    setSeatError(null);
    try {
      await updateSeats(seatInput);
      refresh();
      lensEvent.success('Billing settings updated successfully.');
    } catch (err) {
      setSeatError(err instanceof Error ? err.message : 'Could not update seats.');
    } finally {
      setSeatSaving(false);
    }
  };

  if (loading || roleLoading) {
    return (
      <div className="list-page animate-in">
        <p className="page-subtitle">Loading billing details…</p>
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="list-page animate-in">
        <p className="page-subtitle">{error ?? 'Could not load billing details.'}</p>
        <button type="button" className="ghost-button" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  const { subscription, entitlements, usageToday, billingConfigured } = status;
  const definition = PLAN_DEFINITIONS[subscription.plan];
  const canManage = canManageBilling(role);

  return (
    <div className="list-page animate-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">Billing</h1>
          <p className="page-subtitle">Manage your plan, usage, and payment details.</p>
        </div>
        <Link to="/pricing" className="ghost-button">
          Change plan
        </Link>
      </div>

      <div className="billing-plan-card">
        <div className="billing-plan-card-info">
          <span className="billing-plan-name">{definition.name} plan</span>
          {subscription.status === 'PAST_DUE' && <span className="badge high">Payment failed</span>}
          {subscription.cancelAtPeriodEnd && <span className="badge medium">Cancels at period end</span>}
        </div>
        {subscription.plan !== 'FREE' && canManage && (
          <button
            type="button"
            className="primary-button"
            disabled={portalLoading || !billingConfigured}
            onClick={() => void handleManageBilling()}
          >
            {portalLoading ? 'Opening…' : 'Manage billing'}
          </button>
        )}
      </div>
      {!canManage && <p className="billing-status-note">Only the workspace owner can manage billing.</p>}
      {canManage && !billingConfigured && <p className="billing-status-note">Billing is not configured on this server yet.</p>}
      {portalError && <p className="billing-status-note">{portalError}</p>}

      <div className="section-title">Today&apos;s usage</div>
      <div className="summary-cards-row">
        {usageToday.map((snapshot) => (
          <div className="summary-card" key={snapshot.metric}>
            <span className="count">
              {snapshot.count}
              {snapshot.limit !== null ? ` / ${snapshot.limit}` : ''}
            </span>
            <span className="label">{METRIC_LABEL[snapshot.metric] ?? snapshot.metric}</span>
          </div>
        ))}
      </div>

      {subscription.plan === 'TEAM' && (
        <>
          <div className="section-title">Seats</div>
          <p className="page-subtitle">
            {entitlements.seatsUsed} of {entitlements.seatsIncluded} seats used. Extra seats are $
            {PLAN_DEFINITIONS.TEAM.extraSeatPriceMonthlyUsd}/month each.
          </p>
          {canManage ? (
            <>
              <div className="billing-seat-editor">
                <input
                  type="number"
                  min={PLAN_DEFINITIONS.TEAM.includedSeats}
                  value={seatInput ?? subscription.seatCount}
                  onChange={(e) => setSeatInput(Number(e.target.value))}
                />
                <button type="button" className="ghost-button" disabled={seatSaving} onClick={() => void handleSaveSeats()}>
                  {seatSaving ? 'Saving…' : 'Update seats'}
                </button>
              </div>
              {seatError && <p className="billing-status-note">{seatError}</p>}
            </>
          ) : (
            <p className="billing-status-note">Only the workspace owner can change the seat count.</p>
          )}
        </>
      )}
    </div>
  );
}
