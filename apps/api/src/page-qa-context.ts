import type { BrowserEvidence, HealthScore, Issue } from '@origami/contracts';
import { scrubString } from '@origami/privacy';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_page_qa_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/** Same "own dedicated context budget" pattern as Phase 9's AI_REPOSITORY_QA_MAX_CONTEXT_CHARS — bounds the whole assembled context string regardless of how many issues/console/network entries a page happens to have. */
export const AI_PAGE_QA_MAX_CONTEXT_CHARS = envInt('AI_PAGE_QA_MAX_CONTEXT_CHARS', 8_000);
/** How many top issues (by severity) are ever included — a page can have far more than is useful/boundable in one context. */
const MAX_ISSUES = 20;
/** How many raw console/network entries are ever included — same reasoning as MAX_ISSUES. */
const MAX_EVIDENCE_ENTRIES = 10;

const SEVERITY_RANK: Record<Issue['severity'], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export interface PageQaContextInput {
  url: string;
  pageTitle?: string;
  healthScore?: HealthScore;
  issues: Issue[];
  /** The scan's persisted, already privacy-scrubbed BrowserEvidence (page-scan-runner.ts's PageScanResult.evidence) — undefined for a scan that predates migration 036 or never captured full evidence. */
  evidence?: BrowserEvidence;
}

/**
 * Builds a bounded, deterministic context string from a scan/page's
 * PERSISTED evidence — never live browser evidence, never the whole
 * evidence blob unbounded. Every free-text field is passed through
 * scrubString again here, defense in depth on top of the scan-time
 * privacy-scrubber pass (same posture as repository-ai-context.ts's
 * formatContextBlock, which re-scrubs already-indexed code content).
 */
export function buildPageQaContext(input: PageQaContextInput): string {
  const lines: string[] = [];

  lines.push(`URL: ${input.url}`);
  if (input.pageTitle) lines.push(`Page title: ${scrubString(input.pageTitle)}`);

  if (input.healthScore) {
    lines.push('', 'Health Score:');
    lines.push(`  Overall: ${input.healthScore.overallScore}/100`);
    for (const [category, { score }] of Object.entries(input.healthScore.categories)) {
      lines.push(`  ${category}: ${score}/100`);
    }
  }

  const topIssues = [...input.issues]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_ISSUES);
  if (topIssues.length > 0) {
    lines.push('', `Detected issues (${topIssues.length} of ${input.issues.length} total):`);
    for (const issue of topIssues) {
      lines.push(`  - [${issue.severity}] [${issue.category}] ${scrubString(issue.title)}: ${scrubString(issue.problem)} Suggested fix: ${scrubString(issue.suggestedFix)}`);
    }
  } else {
    lines.push('', 'Detected issues: none.');
  }

  const evidence = input.evidence;
  if (evidence) {
    const perf = evidence.performance;
    if (perf && (perf.lcp !== undefined || perf.cls !== undefined || perf.inp !== undefined || perf.tbt !== undefined || perf.fcp !== undefined || perf.ttfb !== undefined)) {
      lines.push('', 'Performance metrics:');
      if (perf.lcp !== undefined) lines.push(`  Largest Contentful Paint (LCP): ${perf.lcp}ms`);
      if (perf.fcp !== undefined) lines.push(`  First Contentful Paint (FCP): ${perf.fcp}ms`);
      if (perf.ttfb !== undefined) lines.push(`  Time to First Byte (TTFB): ${perf.ttfb}ms`);
      if (perf.tbt !== undefined) lines.push(`  Total Blocking Time (TBT): ${perf.tbt}ms`);
      if (perf.inp !== undefined) lines.push(`  Interaction to Next Paint (INP): ${perf.inp}ms`);
      if (perf.cls !== undefined) lines.push(`  Cumulative Layout Shift (CLS): ${perf.cls}`);
    }

    if (evidence.layout.horizontalOverflow || evidence.layout.elementsOutsideViewport.length > 0) {
      lines.push('', 'Layout:');
      if (evidence.layout.horizontalOverflow) {
        lines.push(`  Horizontal overflow detected${evidence.layout.overflowWidth ? ` (${evidence.layout.overflowWidth}px beyond viewport)` : ''}.`);
      }
      if (evidence.layout.elementsOutsideViewport.length > 0) {
        lines.push(`  ${evidence.layout.elementsOutsideViewport.length} element(s) rendered outside the viewport.`);
      }
    }

    const consoleErrors = evidence.console.filter((e) => e.type === 'error' || e.type === 'exception').slice(0, MAX_EVIDENCE_ENTRIES);
    if (consoleErrors.length > 0) {
      lines.push('', `Console errors (${consoleErrors.length} of ${evidence.console.filter((e) => e.type === 'error' || e.type === 'exception').length} total):`);
      for (const entry of consoleErrors) lines.push(`  - ${scrubString(entry.message)}`);
    }

    const failedRequests = evidence.network.filter((n) => n.failed).slice(0, MAX_EVIDENCE_ENTRIES);
    if (failedRequests.length > 0) {
      lines.push('', `Failed network requests (${failedRequests.length} of ${evidence.network.filter((n) => n.failed).length} total):`);
      for (const req of failedRequests) lines.push(`  - ${req.method} ${scrubString(req.url)} → HTTP ${req.status}`);
    }

    if (evidence.screenshots.length > 0) {
      lines.push('', `Screenshots captured for: ${evidence.screenshots.map((s) => s.viewport).join(', ')} (visual/pixel content is not analyzed for this answer — only the structured evidence above).`);
    }
  } else {
    lines.push('', 'No detailed page evidence is available for this scan (it may predate detailed evidence capture) — answer only from the Health Score and issues above, and say so if that is insufficient.');
  }

  const context = lines.join('\n');
  return context.length > AI_PAGE_QA_MAX_CONTEXT_CHARS ? `${context.slice(0, AI_PAGE_QA_MAX_CONTEXT_CHARS)}…` : context;
}
