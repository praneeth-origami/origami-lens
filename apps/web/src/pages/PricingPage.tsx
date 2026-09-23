import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BillingInterval, SubscriptionPlan } from '@origami/contracts';
import { PLAN_DEFINITIONS } from '@origami/contracts';
import { useAuth } from '../hooks/useAuth';
import { useBillingStatus } from '../hooks/useBillingStatus';
import { createCheckoutSession, ApiRequestError } from '../api/client';
import { OrigamiLensIcon, CheckIcon } from '../components/icons';

const ACTIVE_PLANS: SubscriptionPlan[] = ['FREE', 'DEVELOPER', 'PRO', 'TEAM'];

function formatUsd(amount: number): string {
  return amount === 0 ? '$0' : `$${amount.toLocaleString('en-US')}`;
}

export function PricingPage() {
  const { user, loading: authLoading } = useAuth();
  const { status } = useBillingStatus(Boolean(user));
  const [interval, setInterval] = useState<BillingInterval>('MONTHLY');
  const [teamSeats, setTeamSeats] = useState(PLAN_DEFINITIONS.TEAM.includedSeats);
  const [pendingPlan, setPendingPlan] = useState<SubscriptionPlan | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const currentPlan = status?.subscription.plan;

  const handleCheckout = async (plan: SubscriptionPlan) => {
    setCheckoutError(null);
    setPendingPlan(plan);
    try {
      const { url } = await createCheckoutSession({
        plan,
        interval,
        seats: plan === 'TEAM' ? teamSeats : undefined,
      });
      window.location.href = url;
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'BILLING_NOT_CONFIGURED') {
        setCheckoutError('Billing is not configured on this server yet — an administrator needs to add Stripe API keys.');
      } else {
        setCheckoutError(err instanceof Error ? err.message : 'Could not start checkout.');
      }
      setPendingPlan(null);
    }
  };

  const teamExtraSeats = Math.max(0, teamSeats - PLAN_DEFINITIONS.TEAM.includedSeats);
  const teamExtraCost = useMemo(
    () => teamExtraSeats * (PLAN_DEFINITIONS.TEAM.extraSeatPriceMonthlyUsd ?? 0) * (interval === 'ANNUAL' ? 12 : 1),
    [teamExtraSeats, interval],
  );

  return (
    <div className="pricing-page">
      {/* Only rendered for a signed-out visitor — App.tsx puts a signed-in
          user's /pricing inside the normal app shell, which already has
          TopNav (brand + nav) above this page, so repeating the brand and a
          "Go to Dashboard" link here would just be a duplicate. An
          anonymous visitor has no TopNav at all, so this is their only way
          to see the brand or get to sign-in. */}
      {!authLoading && !user && (
        <header className="pricing-header">
          <Link to="/" className="pricing-brand">
            <OrigamiLensIcon size={30} />
            <span>Origami Lens</span>
          </Link>
          <Link to="/login" className="ghost-button">
            Sign in
          </Link>
        </header>
      )}

      <div className="pricing-intro">
        <h1>Simple, transparent pricing</h1>
        <p>Choose the plan that fits how often you ship. Upgrade, downgrade, or cancel any time.</p>

        <div className="pricing-toggle" role="group" aria-label="Billing interval">
          <button type="button" className={interval === 'MONTHLY' ? 'active' : ''} onClick={() => setInterval('MONTHLY')}>
            Monthly
          </button>
          <button type="button" className={interval === 'ANNUAL' ? 'active' : ''} onClick={() => setInterval('ANNUAL')}>
            Annual <span className="pricing-toggle-badge">2 months free</span>
          </button>
        </div>
      </div>

      {checkoutError && (
        <div className="pricing-error" role="alert">
          {checkoutError}
        </div>
      )}

      <div className="pricing-grid">
        {ACTIVE_PLANS.map((planId) => {
          const definition = PLAN_DEFINITIONS[planId];
          const price = interval === 'ANNUAL' ? definition.priceAnnualUsd : definition.priceMonthlyUsd;
          const isCurrent = currentPlan === planId;
          const isFree = planId === 'FREE';

          return (
            <div key={planId} className={`plan-card ${planId === 'TEAM' ? 'plan-card-highlight' : ''}`}>
              {planId === 'TEAM' && <span className="plan-card-ribbon">Most popular</span>}
              <h2>{definition.name}</h2>
              <p className="plan-card-tagline">{definition.tagline}</p>
              <p className="plan-card-price">
                {formatUsd(price)}
                <span>/{interval === 'ANNUAL' ? 'yr' : 'mo'}</span>
              </p>

              {planId === 'TEAM' && (
                <div className="plan-card-seats">
                  <span>{teamSeats} seats</span>
                  <div className="plan-card-seat-controls">
                    <button
                      type="button"
                      aria-label="Fewer seats"
                      disabled={teamSeats <= definition.includedSeats}
                      onClick={() => setTeamSeats((s) => Math.max(definition.includedSeats, s - 1))}
                    >
                      −
                    </button>
                    <button type="button" aria-label="More seats" onClick={() => setTeamSeats((s) => s + 1)}>
                      +
                    </button>
                  </div>
                  {teamExtraSeats > 0 && (
                    <span className="plan-card-seat-note">
                      +{formatUsd(teamExtraCost)}/{interval === 'ANNUAL' ? 'yr' : 'mo'} for {teamExtraSeats} extra seat{teamExtraSeats === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              )}

              <ul className="plan-card-features">
                {definition.features.map((feature) => (
                  <li key={feature}>
                    <CheckIcon />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              {isCurrent ? (
                <button type="button" className="ghost-button" disabled>
                  Current plan
                </button>
              ) : !user ? (
                <Link to={isFree ? '/register' : `/register?next=/pricing`} className="primary-button plan-card-cta">
                  {isFree ? 'Get started free' : `Choose ${definition.name}`}
                </Link>
              ) : isFree ? (
                <Link to="/billing/settings" className="ghost-button plan-card-cta">
                  Manage plan
                </Link>
              ) : (
                <button
                  type="button"
                  className="primary-button plan-card-cta"
                  disabled={pendingPlan === planId}
                  onClick={() => void handleCheckout(planId)}
                >
                  {pendingPlan === planId ? 'Redirecting…' : `Choose ${definition.name}`}
                </button>
              )}
            </div>
          );
        })}

        <div className="plan-card plan-card-disabled">
          <h2>{PLAN_DEFINITIONS.AGENCY.name}</h2>
          <p className="plan-card-tagline">{PLAN_DEFINITIONS.AGENCY.tagline}</p>
          <ul className="plan-card-features">
            {PLAN_DEFINITIONS.AGENCY.features.map((feature) => (
              <li key={feature}>
                <CheckIcon />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="ghost-button plan-card-cta" disabled>
            Coming soon
          </button>
        </div>
      </div>
    </div>
  );
}
