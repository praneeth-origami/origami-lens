import type { ReactNode } from 'react';
import { pushLensEvent, updateLensEvent, type LensEventAction, type LensEventType } from './lens-event-store';

/** Per-type auto-dismiss defaults, per the approved spec §17/§26 (unchanged from the prior toast system's timings). */
const DEFAULT_DURATION_MS: Record<Exclude<LensEventType, 'active'>, number> = {
  success: 3500,
  info: 4000,
  warning: 5500,
  error: 6500,
  restriction: 10000,
};

export interface LensEventOptions {
  resource?: string;
  detail?: string;
  meta?: string;
  action?: LensEventAction;
  /** Overrides the type's default auto-dismiss duration. */
  duration?: number;
  /** A domain icon (e.g. MailIcon, PullRequestIcon from icons.tsx) shown in place of the default semantic icon for this event's type — used only at the handful of call sites richer than a plain status update. */
  icon?: ReactNode;
}

export interface RestrictionOptions {
  title: string;
  message: string;
  action?: LensEventAction;
  /** "PLAN LIMIT" (usage/plan restrictions) vs "ACCESS RESTRICTED" (RBAC/permission restrictions) — spec §10 vs §11 are visually the same card, different eyebrow. Defaults to 'plan'. */
  kind?: 'plan' | 'access';
  duration?: number;
}

export interface ActiveEventOptions {
  title: string;
  resource?: string;
  detail?: string;
  icon?: ReactNode;
}

export interface CompleteEventOptions {
  type: 'success' | 'error' | 'warning';
  title: string;
  resource?: string;
  detail?: string;
  meta?: string;
  action?: LensEventAction;
  duration?: number;
  icon?: ReactNode;
}

function push(type: Exclude<LensEventType, 'active' | 'restriction'>, title: string, opts?: LensEventOptions): void {
  pushLensEvent({
    type,
    title,
    resource: opts?.resource,
    detail: opts?.detail,
    meta: opts?.meta,
    action: opts?.action,
    icon: opts?.icon,
    duration: opts?.duration ?? DEFAULT_DURATION_MS[type],
  });
}

/**
 * The global Lens Event API — the product's own notification language
 * (spec's FINAL RULE: "every event should feel like a small piece of the
 * Lens inspection experience"), not a generic toast. Callable from
 * anywhere, including plain non-component code like api/client.ts's
 * request()/authRequest() — see lens-event-store.ts's doc comment for why
 * this isn't a React context/hook.
 */
export const lensEvent = {
  success(title: string, opts?: LensEventOptions): void {
    push('success', title, opts);
  },
  error(title: string, opts?: LensEventOptions): void {
    push('error', title, opts);
  },
  warning(title: string, opts?: LensEventOptions): void {
    push('warning', title, opts);
  },
  info(title: string, opts?: LensEventOptions): void {
    push('info', title, opts);
  },
  /**
   * A restriction is not a technical error — "the application is working
   * correctly, but this action isn't available" (spec §2/§10/§11).
   * Visually and semantically distinct from lensEvent.error.
   */
  restriction(options: RestrictionOptions): void {
    pushLensEvent({
      type: 'restriction',
      restrictionKind: options.kind ?? 'plan',
      title: options.title,
      detail: options.message,
      duration: options.duration ?? DEFAULT_DURATION_MS.restriction,
      action: options.action,
    });
  },
  /**
   * A long-running job's card — never auto-dismisses (spec §17). Returns
   * an id; the caller keeps it (typically in a ref, alongside its existing
   * last-seen-status tracking) to later call updateProgress()/complete()
   * on this SAME card rather than pushing a second, separate event.
   */
  active(options: ActiveEventOptions): string {
    return pushLensEvent({
      type: 'active',
      title: options.title,
      resource: options.resource,
      detail: options.detail,
      icon: options.icon,
      startedAt: Date.now(),
    });
  },
  /** Updates an active card in place — only called when the caller has a REAL progress number (e.g. website scan's completedPages/discoveredPages); repository/component jobs skip this entirely and stay indeterminate, per spec's "do not invent" instruction. */
  updateProgress(id: string, patch: { progress?: number; detail?: string }): void {
    updateLensEvent(id, patch);
  },
  /** Morphs an active card into its terminal state (spec §14's "LENS ACTIVE -> LENS EVENT" transition) and starts its auto-dismiss timer — the one card the user was watching simply changes, rather than a second card appearing alongside it. */
  complete(id: string, options: CompleteEventOptions): void {
    updateLensEvent(id, {
      type: options.type,
      title: options.title,
      resource: options.resource,
      detail: options.detail,
      meta: options.meta,
      action: options.action,
      icon: options.icon,
      progress: undefined,
      startedAt: undefined,
      duration: options.duration ?? DEFAULT_DURATION_MS[options.type],
    });
  },
};
