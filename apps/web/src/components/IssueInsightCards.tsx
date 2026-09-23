import type { Issue } from '@origami/contracts';
import { AlertTriangleIcon, ChartIcon, CodeBracketIcon, WrenchIcon } from './icons';

interface Props {
  issue: Pick<Issue, 'problem' | 'cause' | 'impact' | 'suggestedFix'>;
}

/**
 * Problem / Cause / Impact / Suggested Fix as four compact, scannable
 * cards instead of the old bare `<h3>`/`<p>` grid — same four existing
 * Issue fields, no new content invented.
 */
export function IssueInsightCards({ issue }: Props) {
  return (
    <div className="insight-grid">
      <article className="insight-card" data-kind="problem">
        <div className="insight-card-icon"><AlertTriangleIcon /></div>
        <h3>Problem</h3>
        <p>{issue.problem}</p>
      </article>
      <article className="insight-card" data-kind="cause">
        <div className="insight-card-icon"><CodeBracketIcon /></div>
        <h3>Cause</h3>
        <p>{issue.cause}</p>
      </article>
      <article className="insight-card" data-kind="impact">
        <div className="insight-card-icon"><ChartIcon /></div>
        <h3>Impact</h3>
        <p>{issue.impact}</p>
      </article>
      <article className="insight-card" data-kind="fix">
        <div className="insight-card-icon"><WrenchIcon /></div>
        <h3>Suggested Fix</h3>
        <p>{issue.suggestedFix}</p>
      </article>
    </div>
  );
}
