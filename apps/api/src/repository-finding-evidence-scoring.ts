import type { RepositoryFixSourceGrounding } from '@origami/contracts';
import type { FindingEvidenceTokens } from './repository-finding-evidence.js';

const MIN_TEXT_TOKEN_LENGTH = 4;

export interface EvidenceCorrelation {
  /** Internal ranking signal only — never exposed to the API/UI as a fabricated certainty percentage; only `confidence` and `matchedTokens` cross that boundary (see deriveFixSourceGrounding). */
  score: number;
  matchedTokens: string[];
  /** True when at least one high-signal (class/id/tag/testid) token matched — text-word matches alone never set this, since a coincidental word match is far weaker evidence. */
  hasStructuralMatch: boolean;
}

/**
 * Deterministic, explainable containment scoring — never semantic/
 * embedding-based (that's what BGE-M3 + the reranker already do
 * upstream; this is a second, independent signal: does the LITERAL DOM
 * evidence text actually appear in this candidate's real content).
 * Structural tokens count double a plain text word since a shared class
 * name/id/tag/data-testid is far less likely to be coincidental than a
 * shared common word.
 */
export function correlateEvidenceWithText(tokens: FindingEvidenceTokens, candidateText: string): EvidenceCorrelation {
  const lower = candidateText.toLowerCase();
  const matched = new Set<string>();
  let score = 0;
  let hasStructuralMatch = false;
  for (const t of tokens.structural) {
    if (t.length >= 2 && lower.includes(t)) {
      matched.add(t);
      score += 2;
      hasStructuralMatch = true;
    }
  }
  for (const t of tokens.text) {
    if (t.length >= MIN_TEXT_TOKEN_LENGTH && lower.includes(t)) {
      matched.add(t);
      score += 1;
    }
  }
  return { score, matchedTokens: [...matched], hasStructuralMatch };
}

/**
 * Turns the (already-computed) correlation between DOM evidence and the
 * file(s) a fix proposal actually changes into a confidence tier a
 * reviewer can act on — never a synthetic percentage. HIGH requires a
 * real, hard-to-coincidence structural match with nothing stronger found
 * among the OTHER retrieved candidates (the "similar but incorrect
 * component" failure mode this whole module exists to catch); anything
 * less is surfaced honestly rather than dressed up as certain.
 */
export function deriveFixSourceGrounding(
  hadEvidence: boolean,
  selected: EvidenceCorrelation,
  bestAlternative: EvidenceCorrelation | undefined,
): RepositoryFixSourceGrounding {
  if (!hadEvidence) {
    return {
      confidence: 'LOW',
      matchedEvidence: [],
      note: 'This finding had no structured DOM evidence (selector, class, or element snippet) to verify the proposed fix against.',
    };
  }
  if (selected.score === 0) {
    return {
      confidence: 'LOW',
      matchedEvidence: [],
      note: 'The proposed change does not contain any of the DOM evidence (class names, tag, id, or element text) captured for this finding — it may target the wrong file.',
    };
  }
  if (bestAlternative && bestAlternative.score > selected.score) {
    return {
      confidence: 'MEDIUM',
      matchedEvidence: selected.matchedTokens,
      note: 'Another file retrieved for this finding matched the DOM evidence more closely than the file this fix changes — review carefully before approving.',
    };
  }
  if (selected.hasStructuralMatch) {
    return { confidence: 'HIGH', matchedEvidence: selected.matchedTokens };
  }
  return {
    confidence: 'MEDIUM',
    matchedEvidence: selected.matchedTokens,
    note: 'Only visible-text evidence matched (no class name, id, tag, or data-testid) — a weaker signal, review carefully before approving.',
  };
}
