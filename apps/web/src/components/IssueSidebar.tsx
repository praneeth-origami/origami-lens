import type { AggregatedIssue, Issue } from '@origami/contracts';
import { CATEGORY_LABEL, SEVERITY_LABEL, SOURCE_LABEL, STATUS_LABEL } from '../api/client';
import { affectedCount } from './IssueHeader';
import { CheckCircleIcon, ExternalLinkIcon } from './icons';

interface IssueDetailsCardProps {
  issue: Issue | AggregatedIssue;
  scannedAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Real, already-available metadata only — no field here is computed or guessed, each maps 1:1 to an existing Issue property. */
export function IssueDetailsCard({ issue, scannedAt }: IssueDetailsCardProps) {
  const rows: Array<[string, string]> = [
    ['ID', issue.id],
    ['Category', CATEGORY_LABEL[issue.category]],
    ['Severity', SEVERITY_LABEL[issue.severity]],
    ['Status', STATUS_LABEL[issue.status ?? 'open']],
    ['Detector', SOURCE_LABEL[issue.source]],
    ['Confidence', `${Math.round(issue.confidence * 100)}%`],
    ['First seen', formatDate(issue.createdAt ?? scannedAt)],
    ['Last seen', formatDate(scannedAt)],
    ['Affected count', String(affectedCount(issue))],
  ];

  return (
    <section className="sidebar-card">
      <h4>Issue Details</h4>
      <dl className="sidebar-meta-list">
        {rows.map(([label, value]) => (
          <div key={label} className="sidebar-meta-row">
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export interface RelatedLink {
  label: string;
  url: string;
}

interface RelatedLinksCardProps {
  links: RelatedLink[];
}

/**
 * Only renders when the issue actually carries reference links. Nothing in
 * the current Issue/AggregatedIssue API response provides these today (axe
 * results are normalized without their `helpUrl`, and no WCAG/MDN reference
 * field exists anywhere in the contract) — so callers pass `links={[]}` and
 * this card stays hidden rather than showing invented URLs. Wired up ready
 * for the day the API does provide them.
 */
export function RelatedLinksCard({ links }: RelatedLinksCardProps) {
  if (links.length === 0) return null;

  return (
    <section className="sidebar-card">
      <h4>Related Links</h4>
      <ul className="sidebar-link-list">
        {links.map((link) => (
          <li key={link.url}>
            <a href={link.url} target="_blank" rel="noreferrer">
              <span>{link.label}</span>
              <ExternalLinkIcon />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface IssueNextStepsProps {
  fixProposed: boolean;
  fixReviewed: boolean;
  prCreated: boolean;
}

/**
 * Visual-only workflow stepper — no new backend calls. Step 1 is always
 * reached (the reader is looking at the issue right now); steps 2-4 reflect
 * the same aiFixProposal/reviewResponse/prResult state IssueDetailPage
 * already tracks for the "Fix with AI" card, so the checkmarks are real UI
 * state, not decoration.
 */
export function IssueNextSteps({ fixProposed, fixReviewed, prCreated }: IssueNextStepsProps) {
  const steps = [
    { title: 'Review this issue', detail: 'Understand the problem and review evidence.', done: true },
    { title: 'Generate fix with AI', detail: 'Get a proposed code change.', done: fixProposed },
    { title: 'Review and verify', detail: 'Check the changes in your repository.', done: fixReviewed },
    { title: 'Create Pull Request', detail: 'Submit the fix when you’re ready.', done: prCreated },
  ];

  return (
    <section className="sidebar-card">
      <h4>Next Steps</h4>
      <ol className="next-steps-list">
        {steps.map((step, i) => (
          <li key={step.title} className={step.done ? 'done' : ''}>
            <span className="next-step-marker" aria-hidden="true">
              {step.done ? <CheckCircleIcon /> : i + 1}
            </span>
            <span className="next-step-text">
              <span className="next-step-title">{step.title}</span>
              <span className="next-step-detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface IssueSidebarProps {
  issue: Issue | AggregatedIssue;
  scannedAt: string;
  relatedLinks: RelatedLink[];
  fixProposed: boolean;
  fixReviewed: boolean;
  prCreated: boolean;
}

export function IssueSidebar({ issue, scannedAt, relatedLinks, fixProposed, fixReviewed, prCreated }: IssueSidebarProps) {
  return (
    <aside className="issue-detail-aside">
      <IssueDetailsCard issue={issue} scannedAt={scannedAt} />
      <RelatedLinksCard links={relatedLinks} />
      <IssueNextSteps fixProposed={fixProposed} fixReviewed={fixReviewed} prCreated={prCreated} />
    </aside>
  );
}
