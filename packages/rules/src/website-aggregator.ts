import type { AggregatedIssue, Issue, IssueOccurrence, Severity } from '@origami/contracts';
import { randomUUID } from 'node:crypto';

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function buildGroupKey(issue: Issue): string {
  const selector =
    issue.groupKey ??
    (typeof issue.evidence.selector === 'string' ? issue.evidence.selector : undefined) ??
    issue.type;
  return `${issue.category}:${issue.ruleId ?? issue.type}:${selector}`;
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function aggregateWebsiteIssues(
  pageIssues: Array<{ pageScanId: string; url: string; issues: Issue[] }>,
): AggregatedIssue[] {
  const groups = new Map<
    string,
    {
      template: Issue;
      occurrences: IssueOccurrence[];
      affectedPages: Set<string>;
      maxSeverity: Severity;
    }
  >();

  for (const { pageScanId, url, issues } of pageIssues) {
    for (const issue of issues) {
      const key = buildGroupKey(issue);
      const occurrence: IssueOccurrence = {
        pageScanId,
        url,
        evidence: issue.evidence,
      };

      const existing = groups.get(key);
      if (existing) {
        existing.occurrences.push(occurrence);
        existing.affectedPages.add(url);
        existing.maxSeverity = maxSeverity(existing.maxSeverity, issue.severity);
      } else {
        groups.set(key, {
          template: issue,
          occurrences: [occurrence],
          affectedPages: new Set([url]),
          maxSeverity: issue.severity,
        });
      }
    }
  }

  return Array.from(groups.values()).map(({ template, occurrences, affectedPages, maxSeverity }) => ({
    ...template,
    id: randomUUID(),
    severity: maxSeverity,
    occurrenceCount: occurrences.length,
    affectedPages: [...affectedPages],
    occurrences,
    isAggregated: true,
  }));
}
