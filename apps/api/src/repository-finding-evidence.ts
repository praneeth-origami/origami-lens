import type { IssueEvidence } from '@origami/contracts';

/** Matches normalizeAxeViolations' own cap (nodes.slice(0, 3)) — never reads more nested items than the scanner itself ever produced. */
const MAX_ITEMS_CONSIDERED = 3;
const MAX_QUERY_TOKENS = 12;

interface ParsedSelector {
  tag?: string;
  id?: string;
  classNames: string[];
}

/**
 * Parses this codebase's own compact selector format (see
 * services/browser-worker/src/page-scripts.js's getSelector: "#id" | "tag"
 * | "tag.class1.class2") — never a full CSS engine, just this one
 * deterministic shape every rule/axe-core evidence selector is built from.
 */
function parseSelector(raw: string): ParsedSelector {
  const trimmed = raw.trim();
  if (!trimmed) return { classNames: [] };
  if (trimmed.startsWith('#')) return { id: trimmed.slice(1), classNames: [] };
  const [tag, ...classes] = trimmed.split('.');
  return { tag: tag || undefined, classNames: classes.filter(Boolean) };
}

/** Strips tags from a captured HTML snippet (axe-core's node.html) to recover visible text — never a full HTML parser, just enough to pull words a reviewer would recognize. */
function textFromSnippet(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/i).map((w) => w.trim()).filter((w) => w.length >= 4);
}

const ATTRIBUTE_TOKEN_PATTERN = /(?:data-testid|data-test|id|name|aria-label|role)="([^"]+)"/gi;
const CLASS_ATTR_PATTERN = /class="([^"]+)"/i;
const LEADING_TAG_PATTERN = /^<\s*([a-z][a-z0-9]*)/i;

export interface FindingEvidenceTokens {
  /** High-signal tokens (tag names, class names, ids, data-testid/aria/role values) — a coincidental match is unlikely. */
  structural: string[];
  /** Lower-signal tokens (words pulled from visible element text) — more likely to appear elsewhere by coincidence. */
  text: string[];
  hasAny: boolean;
}

/**
 * Pulls concrete DOM-evidence tokens out of an already-captured Issue's
 * evidence — never invents new evidence, never re-scans the page (see the
 * source-grounding investigation report: Step 1 audit). Reads both the
 * top-level fields (selector/snippet, set by most origami-rule matches)
 * and the nested `items[]` fields — the ONLY place axe-core violation
 * evidence lives (normalizeAxeViolations never sets a top-level
 * selector/snippet for an accessibility finding). Used to (a) enrich the
 * repository search query and (b) score how well a candidate/selected
 * file's content actually corresponds to the flagged element.
 */
export function extractEvidenceTokens(evidence: IssueEvidence | undefined): FindingEvidenceTokens {
  const structural = new Set<string>();
  const text = new Set<string>();

  function absorbSelector(raw: unknown): void {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const { tag, id, classNames } = parseSelector(raw);
    if (tag && tag.length >= 2) structural.add(tag.toLowerCase());
    if (id) structural.add(id.toLowerCase());
    for (const c of classNames) if (c.length >= 2) structural.add(c.toLowerCase());
  }

  function absorbSnippet(raw: unknown): void {
    // A bare tag name (e.g. "button", set as `snippet` by several non-axe
    // rules) carries no signal beyond what the selector already gave —
    // only real markup (axe-core's node.html) is worth parsing further.
    if (typeof raw !== 'string' || !raw.includes('<')) return;
    const tagMatch = raw.trim().match(LEADING_TAG_PATTERN);
    if (tagMatch && tagMatch[1].length >= 2) structural.add(tagMatch[1].toLowerCase());
    let match: RegExpExecArray | null;
    const attrPattern = new RegExp(ATTRIBUTE_TOKEN_PATTERN.source, 'gi');
    while ((match = attrPattern.exec(raw))) structural.add(match[1].toLowerCase());
    const classMatch = raw.match(CLASS_ATTR_PATTERN);
    if (classMatch) for (const c of classMatch[1].split(/\s+/)) if (c) structural.add(c.toLowerCase());
    for (const w of words(textFromSnippet(raw))) text.add(w.toLowerCase());
  }

  absorbSelector(evidence?.selector);
  absorbSnippet(evidence?.snippet);
  const items = Array.isArray(evidence?.items) ? evidence!.items!.slice(0, MAX_ITEMS_CONSIDERED) : [];
  for (const item of items) {
    absorbSelector(item?.selector);
    absorbSnippet(item?.snippet);
  }

  return { structural: [...structural], text: [...text], hasAny: structural.size > 0 || text.size > 0 };
}

/** Deterministic, bounded token ordering for the search query — structural tokens first (more locating power), capped so one finding with several axe nodes can't crowd out the title/category within buildFindingSearchQuery's length budget. */
export function evidenceTokensForQuery(tokens: FindingEvidenceTokens): string[] {
  return [...tokens.structural, ...tokens.text].slice(0, MAX_QUERY_TOKENS);
}
