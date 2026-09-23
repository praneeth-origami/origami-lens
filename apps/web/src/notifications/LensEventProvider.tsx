import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { subscribeLensEvents, getLensEventsSnapshot, dismissLatestLensEvent } from './lens-event-store';
import { LensEventCard } from './LensEventCard';

/**
 * Mounted once in App.tsx, wrapping AppShell — the only point common to
 * every route (the no-chrome auth pages, /pricing, /invitations/:token,
 * and the normal app shell all render as separate sibling branches inside
 * AppShell, so a provider placed inside any one of them would be missing
 * from the others). Subscribes to lens-event-store.ts via
 * useSyncExternalStore (built into React, no new dependency) so
 * lensEvent.*() calls from anywhere — including plain non-component code
 * in api/client.ts — are reflected here immediately.
 *
 * Position: bottom-right (spec §15's developer-tool convention), stacked
 * bottom-to-top so the newest card is always closest to the corner.
 */
export function LensEventProvider({ children }: { children: ReactNode }) {
  const events = useSyncExternalStore(subscribeLensEvents, getLensEventsSnapshot);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissLatestLensEvent();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      {children}
      {/* No wrapping aria-live — each card's own role="alert"/"status" already implies the correct implicit live-region assertiveness. */}
      <div className="lens-event-viewport">
        {events.map((event) => (
          <LensEventCard key={event.id} event={event} />
        ))}
      </div>
    </>
  );
}
