import type { Issue, IssueCategory, Severity } from '@origami/contracts';
import { randomUUID } from 'node:crypto';

/**
 * Deduplicates issues by category + ruleId + type, merging counts where appropriate.
 */
export function deduplicateIssues(issues: Issue[]): Issue[] {
  const seen = new Map<string, Issue>();

  for (const issue of issues) {
    const key = issue.groupKey ?? `${issue.category}:${issue.ruleId ?? issue.type}:${issue.evidence.selector ?? issue.title}`;
    const existing = seen.get(key);

    if (existing) {
      const count = ((existing.evidence.count as number) ?? 1) + ((issue.evidence.count as number) ?? 1);
      seen.set(key, {
        ...existing,
        evidence: { ...existing.evidence, count, items: [...(existing.evidence.items ?? []), ...(issue.evidence.items ?? [])].slice(0, 5) },
        title: count > 1 ? updateGroupedTitle(existing.title, count) : existing.title,
      });
    } else {
      seen.set(key, issue);
    }
  }

  return Array.from(seen.values());
}

function updateGroupedTitle(title: string, count: number): string {
  if (title.match(/^\d+/)) {
    return title.replace(/^\d+/, String(count));
  }
  return `${count} similar issues: ${title}`;
}

export function normalizeIssues(rawIssues: Issue[]): Issue[] {
  return deduplicateIssues(
    rawIssues.map((issue) => ({
      ...issue,
      id: issue.id || randomUUID(),
      confidence: Math.min(1, Math.max(0, issue.confidence)),
      problem: issue.problem || issue.title,
      cause: issue.cause || 'Deterministic analysis identified this issue from browser evidence.',
      impact: issue.impact || 'This issue may affect user experience or site quality.',
      suggestedFix: issue.suggestedFix || 'Review the evidence and apply the recommended remediation.',
    })),
  );
}

export class IssueNormalizer {
  normalize(issues: Issue[]): Issue[] {
    return normalizeIssues(issues);
  }

  groupByCategory(issues: Issue[]): Record<IssueCategory, Issue[]> {
    const grouped = {} as Record<IssueCategory, Issue[]>;
    for (const issue of issues) {
      if (!grouped[issue.category]) grouped[issue.category] = [];
      grouped[issue.category].push(issue);
    }
    return grouped;
  }

  groupBySeverity(issues: Issue[]): Record<Severity, Issue[]> {
    return {
      CRITICAL: issues.filter((i) => i.severity === 'CRITICAL'),
      HIGH: issues.filter((i) => i.severity === 'HIGH'),
      MEDIUM: issues.filter((i) => i.severity === 'MEDIUM'),
      LOW: issues.filter((i) => i.severity === 'LOW'),
    };
  }
}
