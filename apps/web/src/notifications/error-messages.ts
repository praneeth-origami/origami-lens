import { lensEvent } from './lens-event';

/**
 * Turns one failed API response into the right Lens Event. Prefers the
 * server's own `error` string when present — the backend audit for this
 * feature confirmed every route in this app already sends a specific,
 * human-readable message (never a stack trace/SQL/path — see
 * apps/api's own error-handling conventions), so re-hardcoding a message
 * per error code here would just drift from the real copy over time.
 * The HTTP-status-based generic fallback below (spec §21/§27) is only
 * reached when the server sent no `error` string at all (e.g. a proxy's
 * raw error page), matching spec §21's own closing instruction: "use
 * structured server errors when available."
 */
export interface ApiErrorInfo {
  status: number;
  code?: string;
  serverMessage?: string;
}

/** Plan/quota restrictions — get the extra "View Plans" action alongside the PLAN LIMIT eyebrow. */
const PLAN_RESTRICTION_CODES = new Set(['USAGE_LIMIT_EXCEEDED', 'MULTI_MEMBER_NOT_SUPPORTED_ON_PLAN']);

function genericMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have permission to perform this action.";
    case 404:
      return 'The requested resource could not be found.';
    case 409:
      return 'This action conflicts with the current state.';
    case 402:
      return "You've reached a usage limit. Please try again later or upgrade your plan.";
    default:
      return 'Something went wrong on our side. Please try again.';
  }
}

/** Fired by api/client.ts's request()/authRequest() on every failed call, unless the caller opted out with `{ silent: true }` (see those two functions) because it already renders its own well-crafted contextual message. */
export function notifyApiError(info: ApiErrorInfo): void {
  if (info.code === 'UNAUTHENTICATED' || info.status === 401) {
    lensEvent.error('Session expired', { detail: 'Please sign in again.' });
    return;
  }

  if (info.code && PLAN_RESTRICTION_CODES.has(info.code)) {
    lensEvent.restriction({
      kind: 'plan',
      title: info.code === 'USAGE_LIMIT_EXCEEDED' ? 'Daily limit reached' : 'Not available on your plan',
      message: info.serverMessage ?? genericMessageForStatus(info.status),
      action: { label: 'View Plans', onClick: () => { window.location.href = '/pricing'; } },
    });
    return;
  }

  // A 403 means "the app is working correctly, this action just isn't
  // available to you" (RBAC/role restriction, spec §2/§11) — not a
  // technical malfunction, so it gets the restriction styling too, just
  // without a plan-upgrade action (there's nothing to upgrade to here).
  if (info.code === 'FORBIDDEN' || info.status === 403) {
    lensEvent.restriction({
      kind: 'access',
      title: 'View-only access',
      message: info.serverMessage ?? genericMessageForStatus(403),
    });
    return;
  }

  lensEvent.error('Something went wrong', { detail: info.serverMessage || genericMessageForStatus(info.status) });
}

/** For the one true network-layer failure case: fetch() itself threw (offline, DNS, CORS, aborted) before any response existed at all — spec §7's NETWORK_ERROR category. */
export function notifyNetworkError(): void {
  lensEvent.error('Connection lost', { detail: 'Unable to reach the server. Check your connection and try again.' });
}
