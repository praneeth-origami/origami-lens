import { scrubString } from '@origami/privacy';
import { buildRepositoryQaContext, type RepositoryContextChunk } from './repository-ai-context.js';

function envInt(name: string, defaultValue: number, minValue = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    console.error(JSON.stringify({ event: 'invalid_repository_config', name, providedValue: raw, minValue, fallback: defaultValue }));
    return defaultValue;
  }
  return parsed;
}

/** Own dedicated budget for the repository-context portion of a finding-fix prompt — a distinct workload from Phase 9 Q&A (same class of reasoning, different default reserved independently so the two can be tuned apart). */
export const AI_REPOSITORY_FIX_MAX_CONTEXT_CHARS = envInt('AI_REPOSITORY_FIX_MAX_CONTEXT_CHARS', 12_000);
/** A finding's evidence (selector/message/snippet/nested items) is attacker- and scanner-controlled data, not trusted code — bounded independently of any code-chunk budget. */
export const AI_FINDING_EVIDENCE_MAX_CHARS = envInt('AI_FINDING_EVIDENCE_MAX_CHARS', 2_000);

export interface FindingSummary {
  title: string;
  severity: string;
  category: string;
  /** A bounded, deterministic combination of the finding's problem/cause/impact/suggestedFix fields — never the raw scan payload. */
  description: string;
  /** Pre-stringified, bounded, scrubbed evidence — see summarizeFindingEvidence. */
  evidence: string;
}

/**
 * Deterministically stringifies an Issue's evidence object into bounded,
 * scrubbed text — never the raw JSON of an arbitrarily deep/large evidence
 * tree (IssueEvidence.items can nest). scrubString runs on the final
 * string since evidence.snippet/message could theoretically contain
 * accidentally-captured sensitive text from a scanned page.
 */
export function summarizeFindingEvidence(evidence: Record<string, unknown> | undefined): string {
  if (!evidence) return '(none)';
  const parts: string[] = [];
  if (typeof evidence.selector === 'string') parts.push(`selector: ${evidence.selector}`);
  if (typeof evidence.message === 'string') parts.push(`message: ${evidence.message}`);
  if (typeof evidence.snippet === 'string') parts.push(`snippet: ${evidence.snippet}`);
  if (typeof evidence.attribute === 'string') parts.push(`attribute: ${evidence.attribute}`);
  if (typeof evidence.value === 'string') parts.push(`value: ${evidence.value}`);
  if (typeof evidence.metric === 'string') parts.push(`metric: ${evidence.metric}${evidence.metricValue !== undefined ? ` = ${evidence.metricValue}` : ''}`);
  if (typeof evidence.count === 'number') parts.push(`count: ${evidence.count}`);
  const joined = parts.length > 0 ? parts.join('\n') : '(no structured evidence fields)';
  const bounded = joined.length > AI_FINDING_EVIDENCE_MAX_CHARS ? `${joined.slice(0, AI_FINDING_EVIDENCE_MAX_CHARS)}…` : joined;
  return scrubString(bounded);
}

function buildFindingBlock(finding: FindingSummary): string {
  return [
    'FINDING', '',
    'Title:', finding.title, '',
    'Severity:', finding.severity, '',
    'Category:', finding.category, '',
    'Description:', finding.description, '',
    'Evidence:', finding.evidence,
  ].join('\n');
}

export interface FindingFixContext {
  contextText: string;
  includedChunks: RepositoryContextChunk[];
}

/**
 * Isolated context builder for Phase 10 (finding -> fix proposal), reusing
 * Phase 9's buildRepositoryQaContext for the code-chunk portion (same
 * bounding algorithm, ranking-order preservation, complete-chunk guarantee
 * — never reimplemented) rather than Phase 9's own function directly, since
 * this use case needs an additional FINDING section prepended and its own
 * budget. Never sends the whole repository — only the finding summary plus
 * as many complete, already-ranked chunks as fit the budget.
 */
export function buildFindingFixContext(finding: FindingSummary, rankedChunks: RepositoryContextChunk[]): FindingFixContext {
  const findingBlock = buildFindingBlock(finding);
  const { contextText: codeContext, includedChunks } = buildRepositoryQaContext(rankedChunks, AI_REPOSITORY_FIX_MAX_CONTEXT_CHARS);

  const contextText = [
    findingBlock, '',
    'REPOSITORY CONTEXT', '',
    codeContext || '(no relevant repository context was retrieved)',
  ].join('\n');

  return { contextText, includedChunks };
}

const MAX_QUERY_LENGTH = 300;

/**
 * Deterministic finding -> search-query construction (never the entire scan
 * payload) — combines only the fields most likely to locate the relevant
 * code: title, category, and (if present) the CSS selector and short
 * evidence message. Bounded to MAX_QUERY_LENGTH, well under
 * REPOSITORY_SEARCH_MAX_QUERY_LENGTH's own ceiling (500) so the query is
 * never rejected by the reused search service for being too long.
 */
export function buildFindingSearchQuery(finding: { title: string; category: string; evidence?: { selector?: string; message?: string } }): string {
  const parts = [finding.title, finding.category, finding.evidence?.selector, finding.evidence?.message]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  const query = parts.join(' ');
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
}
