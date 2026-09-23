import type { ReactNode } from 'react';
import type { AggregatedIssue, Issue, IssueEvidence as IssueEvidenceShape, ScanArtifacts } from '@origami/contracts';
import { CodeBracketIcon, EyeIcon, GlobeIcon, ChartIcon, TerminalIcon } from './icons';
import { ScreenshotViewer } from './ScreenshotViewer';

interface Props {
  issue: Issue | AggregatedIssue;
  scanId: string;
  artifacts?: ScanArtifacts;
}

interface EvidenceRow {
  key: string;
  label: string;
  description: string;
  count?: number;
  icon: ReactNode;
  body: ReactNode;
}

function KeyValueList({ pairs }: { pairs: Array<{ label: string; value: string }> }) {
  if (pairs.length === 0) return null;
  return (
    <ul className="evidence-kv-list">
      {pairs.map((p) => (
        <li key={p.label}>
          <strong>{p.label}</strong>
          <span>{p.value}</span>
        </li>
      ))}
    </ul>
  );
}

function elementPairs(item: IssueEvidenceShape): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  if (item.selector) pairs.push({ label: 'Selector', value: String(item.selector) });
  if (item.snippet) pairs.push({ label: 'HTML', value: String(item.snippet) });
  if (item.attribute) pairs.push({ label: 'Attribute', value: String(item.attribute) });
  if (item.value) pairs.push({ label: 'Value', value: String(item.value) });
  if (item.url) pairs.push({ label: 'URL', value: String(item.url) });
  return pairs;
}

/**
 * Progressive-disclosure Evidence section for the redesigned Issue Detail
 * page — same underlying `Issue.evidence` data the old flat IssueEvidence
 * list rendered, just grouped into typed rows (Console Errors, Network,
 * Accessibility Details, DOM Elements, Performance, Page Screenshot) so the
 * page doesn't have to show everything at once. A row only appears when the
 * issue actually carries that kind of evidence — nothing is fabricated.
 */
export function EvidenceSection({ issue, scanId, artifacts }: Props) {
  const { evidence, source, ruleId } = issue;
  const rows: EvidenceRow[] = [];

  const isConsoleError = ruleId === 'FUNC_CONSOLE_ERROR' && typeof evidence.message === 'string';
  const isNetworkFailure = !isConsoleError
    && (ruleId === 'FUNC_NETWORK_FAILURE' || (evidence.url != null && evidence.statusCode != null));
  const isAxe = !isConsoleError && !isNetworkFailure && source === 'axe-core';

  if (isConsoleError) {
    rows.push({
      key: 'console',
      label: 'Console Errors',
      description: 'JavaScript errors related to this issue',
      count: 1,
      icon: <TerminalIcon />,
      body: (
        <div className="evidence-detail-block">
          <p className="evidence-detail-message">{String(evidence.message)}</p>
          {evidence.stack != null && <pre className="evidence-detail-stack">{String(evidence.stack)}</pre>}
        </div>
      ),
    });
  }

  if (isNetworkFailure) {
    rows.push({
      key: 'network',
      label: 'Network',
      description: 'Failed or slow network request related to this issue',
      icon: <GlobeIcon />,
      body: <KeyValueList pairs={elementPairs(evidence).concat(
        evidence.statusCode != null ? [{ label: 'Status', value: String(evidence.statusCode) }] : [],
      )} />,
    });
  }

  if (isAxe) {
    const items = Array.isArray(evidence.items) ? evidence.items : [];
    rows.push({
      key: 'accessibility',
      label: 'Accessibility Details',
      description: 'axe-core rule details for the affected elements',
      count: typeof evidence.count === 'number' ? evidence.count : items.length || undefined,
      icon: <EyeIcon />,
      body: (
        <div className="evidence-detail-block">
          {evidence.message != null && <p className="evidence-detail-message">{String(evidence.message)}</p>}
          {items.map((item, i) => (
            <div key={i} className="evidence-detail-item">
              <span className="evidence-detail-item-index">Element {i + 1}</span>
              <KeyValueList pairs={elementPairs(item)} />
            </div>
          ))}
        </div>
      ),
    });
  }

  if (!isAxe) {
    const items = Array.isArray(evidence.items) && evidence.items.length > 0
      ? evidence.items
      : evidence.selector
        ? [evidence]
        : [];

    if (items.length > 0) {
      rows.push({
        key: 'dom',
        label: 'DOM Elements',
        description: 'Affected elements in the page',
        count: items.length,
        icon: <CodeBracketIcon />,
        body: (
          <div className="evidence-detail-block">
            {items.map((item, i) => (
              <div key={i} className="evidence-detail-item">
                {items.length > 1 && <span className="evidence-detail-item-index">Element {i + 1}</span>}
                <KeyValueList pairs={elementPairs(item)} />
              </div>
            ))}
          </div>
        ),
      });
    }
  }

  if (evidence.metric != null) {
    rows.push({
      key: 'performance',
      label: 'Performance',
      description: 'Performance metric related to this issue',
      icon: <ChartIcon />,
      body: <KeyValueList pairs={[
        { label: String(evidence.metric), value: String(evidence.metricValue ?? '') },
        ...(evidence.overflowWidth != null ? [{ label: 'Horizontal overflow', value: `${evidence.overflowWidth}px` }] : []),
      ]} />,
    });
  }

  const showScreenshots = issue.category === 'visualMobile' || source === 'vision-ai';

  if (rows.length === 0 && !showScreenshots) return null;

  return (
    <section className="evidence-section">
      <div className="evidence-section-heading">
        <h3>Evidence</h3>
        <p className="muted">Supporting details and data for this issue</p>
      </div>

      <div className="evidence-stack">
        {rows.map((row) => (
          <details key={row.key} className="evidence-row">
            <summary className="evidence-row-summary">
              <span className="evidence-row-icon" aria-hidden="true">{row.icon}</span>
              <span className="evidence-row-text">
                <span className="evidence-row-label">{row.label}</span>
                <span className="evidence-row-desc">{row.description}</span>
              </span>
              {typeof row.count === 'number' && <span className="evidence-row-count">{row.count}</span>}
              <span className="evidence-row-chevron" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </summary>
            <div className="evidence-row-body">{row.body}</div>
          </details>
        ))}

        {showScreenshots && <ScreenshotViewer scanId={scanId} artifacts={artifacts} />}
      </div>
    </section>
  );
}
