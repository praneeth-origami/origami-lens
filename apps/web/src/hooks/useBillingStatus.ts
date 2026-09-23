import { useCallback, useEffect, useState } from 'react';
import type { BillingStatusResponse } from '@origami/contracts';
import { fetchBillingStatus } from '../api/client';

export interface BillingStatusState {
  status: BillingStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Page-local fetch hook (not a Context provider — billing status is only
 * needed on a couple of pages, unlike useAuth's app-wide user) — same
 * load/error/refresh shape every other page in this app builds inline (see
 * ScansListPage.tsx), just factored out since PricingPage and
 * BillingSettingsPage both need it. `enabled` lets PricingPage skip the
 * fetch entirely while the visitor isn't signed in (GET /billing/status
 * requires auth) instead of firing a request that's guaranteed to 401.
 */
export function useBillingStatus(enabled = true): BillingStatusState {
  const [status, setStatus] = useState<BillingStatusResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchBillingStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load billing status'))
      .finally(() => setLoading(false));
  }, [enabled]);

  useEffect(load, [load]);

  return { status, loading, error, refresh: load };
}
