import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApertureIcon } from '../components/icons';
import { dismissLensEvent, type LensEvent, type LensEventType } from './lens-event-store';

/** The small uppercase eyebrow label — the product's own notification language (spec's FINAL RULE), never "Success!"/"Error". */
function eyebrowFor(event: LensEvent): string {
  switch (event.type) {
    case 'success':
      return 'LENS EVENT';
    case 'error':
      return 'LENS ALERT';
    case 'warning':
      return 'LENS WARNING';
    case 'info':
      return 'LENS INFO';
    case 'restriction':
      return event.restrictionKind === 'access' ? 'ACCESS RESTRICTED' : 'PLAN LIMIT';
    case 'active':
      return 'LENS ACTIVE';
  }
}

/** The footer status word — only rendered for terminal (non-active) events. */
function statusWordFor(event: LensEvent): string {
  switch (event.type) {
    case 'success':
      return 'COMPLETED';
    case 'error':
      return 'ACTION REQUIRED';
    case 'warning':
      return 'ATTENTION';
    case 'info':
      return 'NOTICE';
    case 'restriction':
      return event.restrictionKind === 'access' ? 'RESTRICTED' : 'LIMIT REACHED';
    case 'active':
      return '';
  }
}

/** Same established inline-SVG geometry this codebase already uses in HealthBanner.tsx and the prior toast system — kept local to this component rather than a 4th copy in icons.tsx, matching the existing duplication convention for per-component status glyphs. */
const STATUS_ICONS: Record<LensEventType, ReactNode> = {
  success: <path d="M5 13l4 4L19 7" />,
  warning: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  error: <><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></>,
  restriction: <><rect x="4" y="10.5" width="16" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>,
  active: <circle cx="12" cy="12" r="9" />,
};

const ROLE_FOR: Record<LensEventType, 'alert' | 'status'> = {
  success: 'status',
  info: 'status',
  warning: 'status',
  active: 'status',
  error: 'alert',
  restriction: 'alert',
};

const EXIT_ANIMATION_MS = 200;

function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, (now - startedAt) / 1000);
  return <span className="lens-event-meta">{seconds.toFixed(1)}s elapsed</span>;
}

export function LensEventCard({ event }: { event: LensEvent }) {
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);

  const startDismiss = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    window.setTimeout(() => dismissLensEvent(event.id), EXIT_ANIMATION_MS);
  };

  useEffect(() => {
    if (event.duration === undefined) return;
    const timer = window.setTimeout(startDismiss, event.duration);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, event.duration]);

  const isActive = event.type === 'active';

  return (
    <div className={`lens-event-card lens-event-${event.type}${leaving ? ' leaving' : ''}`} role={ROLE_FOR[event.type]}>
      <div className="lens-event-eyebrow">
        <ApertureIcon />
        <span>{eyebrowFor(event)}</span>
      </div>

      <div className="lens-event-body">
        <p className="lens-event-title">
          {event.icon && <span className="lens-event-title-icon" aria-hidden="true">{event.icon}</span>}
          {event.title}
        </p>
        {event.resource && <p className="lens-event-resource">{event.resource}</p>}
        {event.detail && <p className="lens-event-detail">{event.detail}</p>}

        {isActive && (
          <div className="lens-event-progress-row">
            <div className="lens-event-progress-track">
              {event.progress !== undefined ? (
                <div className="lens-event-progress-fill" style={{ width: `${Math.min(100, Math.max(0, event.progress))}%` }} />
              ) : (
                <div className="lens-event-progress-fill indeterminate" />
              )}
            </div>
            {event.startedAt !== undefined && <ElapsedTime startedAt={event.startedAt} />}
          </div>
        )}

        {event.action && (
          <button
            type="button"
            className="lens-event-action"
            onClick={() => { event.action!.onClick(); if (!isActive) startDismiss(); }}
          >
            {event.action.label}
          </button>
        )}
      </div>

      {!isActive && (
        <div className="lens-event-footer">
          <span className="lens-event-status">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {STATUS_ICONS[event.type]}
            </svg>
            {statusWordFor(event)}
          </span>
          {event.meta && <span className="lens-event-meta">{event.meta}</span>}
        </div>
      )}

      <button type="button" className="lens-event-dismiss" aria-label="Dismiss" onClick={startDismiss}>
        ✕
      </button>
    </div>
  );
}
