import type { HealthScore, Issue, MonitoringEvent } from '@origami/contracts';
import { scrubString } from '@origami/privacy';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

/** Same "own dedicated context budget" pattern as page-qa-context.ts's AI_PAGE_QA_MAX_CONTEXT_CHARS. */
export const AI_MONITORING_ASK_MAX_CONTEXT_CHARS = envInt('AI_MONITORING_ASK_MAX_CONTEXT_CHARS', 8_000);
const MAX_ISSUES = 15;

const SEVERITY_RANK: Record<Issue['severity'], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export interface MonitoringAskContextInput {
  site: { name: string; url: string };
  currentHealthScore?: HealthScore;
  previousHealthScore?: HealthScore;
  /** The events the DETERMINISTIC regression engine already produced for the current scan — the AI only ever explains these, it never decides whether a regression exists (see monitoring-ask-service.ts's doc comment). */
  events: MonitoringEvent[];
  currentIssues: Issue[];
}

/**
 * Builds a bounded, deterministic context string from ALREADY-DETECTED
 * monitoring regressions and the two scans' already-computed HealthScores
 * — never live browser evidence, never a second regression-detection pass.
 * Every free-text field is re-scrubbed here, defense in depth on top of
 * the scan-time privacy-scrubber pass (same posture as page-qa-context.ts).
 */
export function buildMonitoringAskContext(input: MonitoringAskContextInput): string {
  const lines: string[] = [];

  lines.push(`Monitored website: ${scrubString(input.site.name)} (${input.site.url})`);

  if (input.currentHealthScore) {
    lines.push('', 'Current Health Score:');
    lines.push(`  Overall: ${input.currentHealthScore.overallScore}/100`);
    for (const [category, { score }] of Object.entries(input.currentHealthScore.categories)) {
      lines.push(`  ${category}: ${score}/100`);
    }
  }
  if (input.previousHealthScore) {
    lines.push('', 'Previous scan Health Score:');
    lines.push(`  Overall: ${input.previousHealthScore.overallScore}/100`);
  }

  if (input.events.length > 0) {
    lines.push('', `Regressions already detected by Origami Lens's deterministic monitoring engine (${input.events.length}):`);
    for (const event of input.events) {
      lines.push(`  - [${event.severity}] ${scrubString(event.title)}: ${scrubString(event.description)}`);
    }
  } else {
    lines.push('', 'No regressions were detected for this scan — if asked why the score changed, explain that it did not meaningfully regress.');
  }

  const topIssues = [...input.currentIssues].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_ISSUES);
  if (topIssues.length > 0) {
    lines.push('', `Current open issues (${topIssues.length} of ${input.currentIssues.length} total, most severe first):`);
    for (const issue of topIssues) {
      lines.push(`  - [${issue.severity}] [${issue.category}] ${scrubString(issue.title)}: ${scrubString(issue.problem)}`);
    }
  }

  const context = lines.join('\n');
  return context.length > AI_MONITORING_ASK_MAX_CONTEXT_CHARS ? `${context.slice(0, AI_MONITORING_ASK_MAX_CONTEXT_CHARS)}…` : context;
}
