import { useAnimateOnVisible } from '../hooks/useAnimateOnVisible';
import { useCountUp, formatCountUp } from '../hooks/useCountUp';

export interface AnimatedScoreRingProps {
  score: number;
  tier: 'good' | 'fair' | 'poor';
  /** Text shown under the number (e.g. "Excellent", "Health Score") — omitted entirely when not provided, matching the compact table-row ring's existing bare-number look. */
  statusLabel?: string;
  small?: boolean;
  ariaLabel: string;
}

/**
 * The one shared circular Health Score indicator — a conic-gradient ring
 * driven by the `--score` CSS custom property (registered via `@property`
 * in dashboard.css so the browser can transition it smoothly, since a plain
 * `background` transition can't interpolate a gradient's underlying angle).
 * Starts at 0 and sweeps up to the real score once the ring scrolls into
 * view; the percentage text counts up in step via requestAnimationFrame.
 * Both stop exactly at the real score — never a fabricated or re-rounded
 * value. Replaces three previously separate copies of this same markup
 * (ScanSummary's HealthScoreCard, the Scans list page's compact ring, and
 * the public SharedReportPage).
 */
export function AnimatedScoreRing({ score, tier, statusLabel, small, ariaLabel }: AnimatedScoreRingProps) {
  const { ref, visible, reducedMotion } = useAnimateOnVisible<HTMLDivElement>();
  const shouldAnimate = visible && !reducedMotion;
  const displayValue = useCountUp(score, shouldAnimate, 1200, reducedMotion);
  const ringScore = reducedMotion || visible ? score : 0;

  return (
    <div
      ref={ref}
      className={small ? 'score-ring small' : 'score-ring'}
      data-tier={tier}
      style={{ ['--score' as string]: `${ringScore}` }}
      aria-label={ariaLabel}
    >
      <div className="score-ring-inner">
        <div className="score-number">{formatCountUp(displayValue, score)}</div>
        {statusLabel && <div className="score-status">{statusLabel}</div>}
      </div>
    </div>
  );
}
