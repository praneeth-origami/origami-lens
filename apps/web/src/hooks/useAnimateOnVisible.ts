import { useEffect, useRef, useState } from 'react';

export interface AnimateOnVisibleState<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  /** True once the element has entered the viewport — stays true afterward (never resets on scroll-away), so an entrance animation plays exactly once per mount rather than replaying every time the user scrolls past. Always true immediately for prefers-reduced-motion. */
  visible: boolean;
  reducedMotion: boolean;
}

/**
 * Shared visibility gate for entrance animations (progress bars, score rings)
 * across the app — one IntersectionObserver per element, disconnected as
 * soon as it fires. Callers render their "0" state until `visible` flips to
 * true, then render the real value; the actual animation is left to CSS
 * transitions on the resulting property change, not driven frame-by-frame
 * from here.
 */
export function useAnimateOnVisible<T extends HTMLElement>(): AnimateOnVisibleState<T> {
  const ref = useRef<T>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handleChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return { ref, visible, reducedMotion };
}
