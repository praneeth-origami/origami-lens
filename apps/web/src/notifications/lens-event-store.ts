/**
 * A tiny module-level external store (subscribe/getSnapshot), not a state
 * library — this is intentional per the spec's "do not introduce
 * unnecessary global state libraries" instruction. Plain functions here are
 * callable from ANYWHERE, including non-component code like api/client.ts's
 * request()/authRequest(), which is the whole point: those two functions
 * are the two real choke points every API call already goes through, and
 * neither can call a React hook directly.
 */
import type { ReactNode } from 'react';

export type LensEventType = 'success' | 'error' | 'warning' | 'info' | 'restriction' | 'active';

export interface LensEventAction {
  label: string;
  onClick: () => void;
}

export interface LensEvent {
  id: string;
  type: LensEventType;
  /** The small uppercase eyebrow label — "LENS EVENT" / "LENS ALERT" / etc. Derived from `type` by lens-event.ts's callers; `restrictionKind` picks between "PLAN LIMIT" and "ACCESS RESTRICTED" for the restriction type specifically. */
  restrictionKind?: 'plan' | 'access';
  title: string;
  /** A resource name (repo, hostname, email) — rendered in the monospace metadata line. */
  resource?: string;
  /** Prose detail (an error message) or structured metadata ("192 chunks · 1024 embeddings"). */
  detail?: string;
  /** Right-aligned footer metadata, e.g. an elapsed-time string ("3.2s") for a just-completed event. */
  meta?: string;
  /** 0-100; only meaningful while type === 'active' and only when the caller actually has a real number (website scans) — undefined means indeterminate (shimmer fill), never a fabricated percentage. */
  progress?: number;
  /** Set once, when an 'active' event is created — the card computes its own live-ticking elapsed time from this rather than requiring the caller to push time updates every second. */
  startedAt?: number;
  action?: LensEventAction;
  /** Milliseconds before auto-dismiss; undefined means "never auto-dismiss" — always true for `active` events (only lensEvent.complete's own duration ever starts their timer) and for a restriction/error important enough to opt out. */
  duration?: number;
  /** A domain icon (MailIcon, PullRequestIcon, CodeBracketIcon from icons.tsx) shown next to the title — only set at the handful of call sites richer than a plain status update; the eyebrow's ApertureIcon (brand mark) is unconditional and unaffected by this. */
  icon?: ReactNode;
}

/** Non-active events are capped at this many visible at once (spec §16) — pushing a new one past the cap immediately dismisses the oldest non-active event. Active events (real ongoing work) are exempt. */
const MAX_VISIBLE_TERMINAL_EVENTS = 3;

let events: LensEvent[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeLensEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLensEventsSnapshot(): LensEvent[] {
  return events;
}

let nextId = 0;

export function pushLensEvent(event: Omit<LensEvent, 'id'>): string {
  const id = `lens-event-${++nextId}`;

  if (event.type !== 'active') {
    const visibleTerminal = events.filter((e) => e.type !== 'active');
    if (visibleTerminal.length >= MAX_VISIBLE_TERMINAL_EVENTS) {
      const oldest = visibleTerminal[0];
      events = events.filter((e) => e.id !== oldest.id);
    }
  }

  events = [...events, { ...event, id }];
  emit();
  return id;
}

export function updateLensEvent(id: string, patch: Partial<Omit<LensEvent, 'id'>>): void {
  const index = events.findIndex((e) => e.id === id);
  if (index === -1) return;
  events = events.map((e, i) => (i === index ? { ...e, ...patch } : e));
  emit();
}

export function dismissLensEvent(id: string): void {
  const next = events.filter((e) => e.id !== id);
  if (next.length === events.length) return;
  events = next;
  emit();
}

/** The most recently added event — what Escape dismisses first. Never dismisses an `active` event this way (real ongoing work shouldn't disappear on a stray Escape) — falls back to the next-most-recent terminal one. */
export function dismissLatestLensEvent(): void {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'active') {
      dismissLensEvent(events[i].id);
      return;
    }
  }
}
