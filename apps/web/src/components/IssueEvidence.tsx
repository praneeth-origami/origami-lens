import type { Issue } from '@origami/contracts';

interface Props {
  issue: Issue;
  compact?: boolean;
}

export function IssueEvidence({ issue, compact = false }: Props) {
  const { evidence, source } = issue;
  const items: { label: string; value: string }[] = [];

  if (evidence.message) items.push({ label: 'Console Error', value: String(evidence.message) });
  if (evidence.url) items.push({ label: 'Network', value: String(evidence.url) });
  if (evidence.statusCode) items.push({ label: 'HTTP Status', value: String(evidence.statusCode) });
  if (evidence.selector) items.push({ label: 'DOM Selector', value: String(evidence.selector) });
  if (evidence.metric) {
    items.push({
      label: evidence.metric === 'LCP' || evidence.metric === 'CLS' ? 'Performance' : String(evidence.metric),
      value: String(evidence.metricValue ?? evidence.metric),
    });
  }
  if (evidence.overflowWidth) {
    items.push({ label: 'Responsive', value: `Horizontal overflow ${evidence.overflowWidth}px` });
  }
  if (evidence.count && evidence.count > 1) {
    items.push({ label: 'Affected count', value: String(evidence.count) });
  }

  if (items.length === 0 && !compact) {
    return (
      <div className="issue-evidence">
        <h4>Evidence</h4>
        <pre>{JSON.stringify(evidence, null, 2)}</pre>
        <p className="source-tag">Source: {source}</p>
      </div>
    );
  }

  if (items.length === 0) return null;

  return (
    <div className={`issue-evidence ${compact ? 'compact' : ''}`}>
      {!compact && <h4>Evidence</h4>}
      <ul>
        {items.slice(0, compact ? 2 : undefined).map((item) => (
          <li key={item.label}>
            <strong>{item.label}</strong>
            <span>{item.value}</span>
          </li>
        ))}
      </ul>
      {!compact && <p className="source-tag">Source: {source} · Confidence: {(issue.confidence * 100).toFixed(0)}%</p>}
    </div>
  );
}
