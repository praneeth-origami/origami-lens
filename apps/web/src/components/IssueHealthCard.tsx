import type { HealthScore, IssueCategory } from '@origami/contracts';
import { CATEGORY_LABEL } from '../api/client';
import { AnimatedScoreRing } from './AnimatedScoreRing';
import { AnimatedProgressBar } from './AnimatedProgressBar';

interface Props {
  healthScore?: HealthScore;
  category: IssueCategory;
}

function tierOf(score: number): 'good' | 'fair' | 'poor' {
  return score >= 90 ? 'good' : score >= 75 ? 'good' : score >= 60 ? 'fair' : 'poor';
}

/**
 * Compact "Page Health Score" card for the Issue Detail page — the real,
 * already-computed scan health score (never a fabricated per-issue delta,
 * since the API has no such value). Shows the overall score plus this
 * issue's own category score, so the reader sees how this issue's category
 * is pulling the total down without inventing a number the backend never
 * sent. Renders nothing if the scan has no health score (e.g. a scan that
 * hasn't completed).
 */
export function IssueHealthCard({ healthScore, category }: Props) {
  if (!healthScore) return null;

  const overall = healthScore.overallScore;
  const categoryScore = healthScore.categories[category];
  const tier = tierOf(overall);

  return (
    <section className="issue-health-card">
      <AnimatedScoreRing
        score={overall}
        tier={tier}
        statusLabel="Health Score"
        ariaLabel={`Page health score ${overall} out of 100`}
      />
      {categoryScore && (
        <div className="issue-health-category">
          <div className="issue-health-category-label">
            <span>{CATEGORY_LABEL[category]} category score</span>
            <span className="issue-health-category-value">{categoryScore.score}</span>
          </div>
          <AnimatedProgressBar
            percent={categoryScore.score}
            dataKey={category}
            trackClassName="category-progress-track"
            fillClassName="category-progress-fill"
          />
          <p className="issue-health-note">This issue contributes to the {CATEGORY_LABEL[category].toLowerCase()} category score above.</p>
        </div>
      )}
    </section>
  );
}
