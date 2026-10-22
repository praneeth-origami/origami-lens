import { useEffect, useRef } from 'react';

/**
 * Fires `onVisible` exactly once, the first time the returned ref's element
 * scrolls into the viewport — one IntersectionObserver per element,
 * disconnected immediately after it fires. Used to lazy-trigger a data fetch
 * only for rows actually on screen (e.g. RepoPrStrategyBadge in a long
 * repository table), rather than firing N requests the instant the page
 * loads. Distinct from useAnimateOnVisible (entrance-animation state +
 * prefers-reduced-motion) — this is a plain fetch trigger, not an animation.
 */
export function useOnVisible<T extends HTMLElement>(onVisible: () => void): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  const callbackRef = useRef(onVisible);
  callbackRef.current = onVisible;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      callbackRef.current();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          callbackRef.current();
          observer.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return ref;
}
