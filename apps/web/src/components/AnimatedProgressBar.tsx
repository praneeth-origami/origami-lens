import { useAnimateOnVisible } from '../hooks/useAnimateOnVisible';

export interface AnimatedProgressBarProps {
  percent: number;
  /** Forwarded to the fill element as `data-key`, matching the existing per-category color selectors (`.category-progress-fill[data-key='...']`) — omitted for bars with a single fixed color (e.g. the repository language bars). */
  dataKey?: string;
  trackClassName: string;
  fillClassName: string;
}

/**
 * The one shared linear progress bar — renders its track/fill exactly as
 * before (same class names, same colors, same dimensions), just starting
 * the fill at 0% and animating to the real percentage once it scrolls into
 * view. The actual sweep is a plain CSS `width` transition already defined
 * on `.category-progress-fill`/`.repo-language-bar-fill`; this component
 * only supplies the one-time 0→real state flip that triggers it. Reused by
 * ScanSummary's CategoryScoreList, the public SharedReportPage, and the
 * Repository Detail page's language breakdown — previously three separate
 * copies of the same track/fill markup.
 */
export function AnimatedProgressBar({ percent, dataKey, trackClassName, fillClassName }: AnimatedProgressBarProps) {
  const { ref, visible, reducedMotion } = useAnimateOnVisible<HTMLDivElement>();
  const width = reducedMotion || visible ? percent : 0;

  return (
    <div ref={ref} className={trackClassName}>
      <span className={fillClassName} data-key={dataKey} style={{ width: `${width}%` }} />
    </div>
  );
}
