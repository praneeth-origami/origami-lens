import { useEffect, useState } from 'react';

/**
 * Counts from 0 up to `target` over `durationMs`, eased out (cubic), driven
 * by requestAnimationFrame — only runs while `shouldAnimate` is true and
 * stops itself the instant it reaches 1.0 progress, so this is a bounded
 * handful of re-renders (one per frame for ~1.2s), never a continuous loop.
 * `showFinalImmediately` (prefers-reduced-motion) skips the animation
 * entirely and returns `target` on every render.
 */
export function useCountUp(target: number, shouldAnimate: boolean, durationMs: number, showFinalImmediately: boolean): number {
  const [value, setValue] = useState(showFinalImmediately ? target : 0);

  useEffect(() => {
    if (showFinalImmediately) {
      setValue(target);
      return;
    }
    if (!shouldAnimate) return;

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t >= 1) {
        setValue(target);
        return;
      }
      setValue(target * eased);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shouldAnimate, target, durationMs, showFinalImmediately]);

  return value;
}

/** Formats an in-flight counted-up value the same way its real target is displayed (1 decimal if the target itself has a fraction, whole number otherwise) — the final frame always renders `target` verbatim, never a re-derived/rounded copy, so the settled value exactly matches the real score. */
export function formatCountUp(current: number, target: number): string {
  const isDecimal = !Number.isInteger(target);
  if (current >= target) return isDecimal ? target.toFixed(1) : String(target);
  return isDecimal ? current.toFixed(1) : String(Math.round(current));
}
