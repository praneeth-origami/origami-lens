import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Subscription } from '@origami/contracts';
import { fetchCheckoutSession } from '../api/client';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 15;

/**
 * Polls GET /billing/session/:sessionId with short backoff until the
 * webhook has actually updated the subscription — see billing-service.ts's
 * getCheckoutSessionStatus doc comment. This page NEVER flips its own state
 * optimistically based on Stripe's redirect alone; it only ever reflects
 * whatever the server currently reports.
 */
export function BillingSuccessPage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const settled = Boolean(subscription && subscription.plan !== 'FREE');

  useEffect(() => {
    if (!sessionId || settled || pollCount >= MAX_POLLS) return;
    const timer = setTimeout(
      () => {
        fetchCheckoutSession(sessionId)
          .then((result) => setSubscription(result.subscription))
          .catch((err) => setError(err instanceof Error ? err.message : 'Could not check your subscription status.'))
          .finally(() => setPollCount((c) => c + 1));
      },
      pollCount === 0 ? 0 : POLL_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [sessionId, settled, pollCount]);

  if (!sessionId) {
    return (
      <div className="billing-status-page">
        <h1>Missing checkout session</h1>
        <p>We couldn&apos;t find a checkout session to confirm. If you completed a purchase, check your billing settings.</p>
        <Link to="/billing/settings" className="primary-button">
          Go to billing settings
        </Link>
      </div>
    );
  }

  if (settled) {
    return (
      <div className="billing-status-page">
        <h1>You&apos;re all set!</h1>
        <p>Your {subscription!.plan} plan is now active.</p>
        <Link to="/" className="primary-button">
          Go to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="billing-status-page">
      <h1>Activating your plan…</h1>
      <p>Stripe confirmed your payment — we&apos;re finishing setup on our end. This usually takes a few seconds.</p>
      <div className="billing-status-spinner" aria-hidden="true" />
      {pollCount >= MAX_POLLS && (
        <p className="billing-status-note">
          This is taking longer than expected. Refresh this page in a moment, or check{' '}
          <Link to="/billing/settings">billing settings</Link>.
        </p>
      )}
      {error && <p className="billing-status-note">{error}</p>}
    </div>
  );
}
