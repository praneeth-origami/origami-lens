/**
 * The one canonical "report representation" — every export format (PDF/
 * JSON/Markdown/CSV) and the public share page all read from
 * `buildLensReport`'s output, never from a raw ScanResponse/DB row
 * directly. This is deliberate: it's the single place that (a) reads the
 * Health Score verbatim off `scan.healthScore` (never recalculates it —
 * packages/scoring is the only source of truth for that), (b) carries the
 * real scan status through instead of ever fabricating a "completed"
 * report for a scan that hasn't finished, and (c) scrubs every free-text
 * field through @origami/privacy before it can reach an export or a
 * public page.
 */
import type { AggregatedIssue, Issue, IssueCategory, LensReport, LensReportIssue, ScanResponse } from '@origami/contracts';
import { CATEGORY_LABEL, REPORT_VERSION } from '@origami/contracts';
import { scrubString } from '@origami/privacy';

function isAggregated(issue: Issue | AggregatedIssue): issue is AggregatedIssue {
  return 'occurrenceCount' in issue;
}

function toLensReportIssue(issue: Issue | AggregatedIssue): LensReportIssue {
  const aggregated = isAggregated(issue) ? issue : undefined;
  return {
    id: issue.id,
    title: scrubString(issue.title),
    severity: issue.severity,
    category: issue.category,
    status: issue.status,
    problem: scrubString(issue.problem),
    cause: scrubString(issue.cause),
    impact: scrubString(issue.impact),
    suggestedFix: scrubString(issue.suggestedFix),
    url: issue.evidence.url ? scrubString(issue.evidence.url) : issue.url ? scrubString(issue.url) : undefined,
    selector: issue.evidence.selector,
    occurrenceCount: aggregated?.occurrenceCount,
    affectedPages: aggregated?.affectedPages?.map((page) => scrubString(page)),
  };
}

/** REPORT_STATUSES a report is ever built "complete" for — everything else (QUEUED/RUNNING/FAILED/CANCELLED) gets null scores rather than a fabricated report (spec §14). */
const READY_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);

export function isReportReady(status: ScanResponse['status']): boolean {
  return !!status && READY_STATUSES.has(status);
}

export function buildLensReport(scan: ScanResponse): LensReport {
  const ready = isReportReady(scan.status);
  const categories = ready
    ? (Object.fromEntries(
        Object.entries(scan.healthScore.categories).map(([key, value]) => [key, value.score]),
      ) as Record<IssueCategory, number>)
    : null;

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    scanId: scan.scanId,
    url: scan.url,
    reportStatus: scan.status ?? 'COMPLETED',
    scannedAt: scan.scannedAt,
    healthScore: ready ? scan.healthScore.overallScore : null,
    categories,
    summary: {
      critical: scan.summary.critical,
      high: scan.summary.high,
      medium: scan.summary.medium,
      low: scan.summary.low,
    },
    issues: ready ? scan.issues.map(toLensReportIssue) : [],
  };
}

/** origami-lens-example-com-report.pdf, never a raw/unsanitized hostname (spec §18). */
export function sanitizeHostnameForFilename(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }
  return hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
}

export function reportFilename(url: string, kind: 'report' | 'issues', extension: string): string {
  return `origami-lens-${sanitizeHostnameForFilename(url)}-${kind}.${extension}`;
}

export function renderReportJson(report: LensReport): string {
  return JSON.stringify(report, null, 2);
}

function formatCategoryTable(report: LensReport): string {
  if (!report.categories) return '_Category scores are not available — this scan did not complete successfully._\n';
  const rows = (Object.entries(report.categories) as [IssueCategory, number][])
    .map(([key, score]) => `| ${CATEGORY_LABEL[key]} | ${score} |`)
    .join('\n');
  return `| Category | Score |\n|---|---:|\n${rows}\n`;
}

export function renderReportMarkdown(report: LensReport): string {
  const lines: string[] = [];
  lines.push('# Origami Lens Report', '');
  lines.push('## Website', '', report.url, '');
  if (!isReportReady(report.reportStatus)) {
    lines.push('## Status', '', `This scan has not completed successfully (status: ${report.reportStatus}) — no health score or issues are available yet.`, '');
    return lines.join('\n');
  }
  lines.push('## Health Score', '', `${report.healthScore} / 100`, '');
  lines.push('## Category Scores', '', formatCategoryTable(report), '');
  lines.push('## Issue Summary', '', `- Critical: ${report.summary.critical}`, `- High: ${report.summary.high}`, `- Medium: ${report.summary.medium}`, `- Low: ${report.summary.low}`, '');
  lines.push('## Issues', '');
  for (const issue of report.issues) {
    lines.push(`### ${issue.severity} — ${issue.title}`, '');
    lines.push(`**Category:** ${CATEGORY_LABEL[issue.category]}`, '');
    lines.push('**Problem**', '', issue.problem, '');
    lines.push('**Cause**', '', issue.cause, '');
    lines.push('**Impact**', '', issue.impact, '');
    lines.push('**Suggested Fix**', '', issue.suggestedFix, '');
    if (issue.url) lines.push('**URL**', '', issue.url, '');
    if (issue.selector) lines.push('**Selector**', '', `\`${issue.selector}\``, '');
    lines.push('---', '');
  }
  return lines.join('\n');
}

const CSV_COLUMNS = ['Issue ID', 'Title', 'Severity', 'Category', 'Status', 'URL', 'Selector', 'Problem', 'Cause', 'Impact', 'Suggested Fix'] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function renderReportCsv(report: LensReport): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const issue of report.issues) {
    rows.push(
      [
        issue.id,
        issue.title,
        issue.severity,
        CATEGORY_LABEL[issue.category],
        issue.status ?? '',
        issue.url ?? '',
        issue.selector ?? '',
        issue.problem,
        issue.cause,
        issue.impact,
        issue.suggestedFix,
      ]
        .map((value) => csvEscape(String(value)))
        .join(','),
    );
  }
  return rows.join('\r\n');
}
