import type { ComponentEvidence, ElementActionErrorCode, ElementActionResponse, ElementActionType } from '@origami/contracts';
import { detectBlockingSensitiveContent, sanitizeComponentEvidence } from '@origami/privacy';
import { buildElementQaContext } from './element-qa-context.js';
import { ElementQaProviderError, type ElementQaProvider } from './element-qa-provider.js';
import { AskError, answerRepositoryQuestion, type AskProviderDeps, type AskRequestParams, type RepositoryAskStores } from './repository-ai-service.js';

export class ElementActionError extends Error {
  constructor(message: string, public readonly code: ElementActionErrorCode) {
    super(message);
    this.name = 'ElementActionError';
  }
}

export interface ElementActionDeps {
  qaProvider: ElementQaProvider;
}

function validateEvidence(evidence: ComponentEvidence | undefined): asserts evidence is ComponentEvidence {
  if (!evidence?.sourceUrl || !evidence.element) {
    throw new ElementActionError('evidence.sourceUrl and evidence.element are required', 'ACTION_FAILED');
  }
  try {
    new URL(evidence.sourceUrl);
  } catch {
    throw new ElementActionError('evidence.sourceUrl is not a valid URL', 'ACTION_FAILED');
  }
}

/**
 * Turns a selected element's evidence into a natural-language search query —
 * the "selected DOM -> evidence tokens" bridge the roadmap asks for. This is
 * the ONLY new piece for the repository-grounded path: retrieval itself
 * (embedding, pgvector, reranking) is entirely searchRepository()'s existing
 * job, invoked unchanged via answerRepositoryQuestion below.
 */
function buildElementSearchQuery(evidence: ComponentEvidence, action: ElementActionType, instruction?: string): string {
  const el = evidence.element;
  const classes = el.classList && el.classList.length > 0 ? ` with class${el.classList.length > 1 ? 'es' : ''} ${el.classList.join(', ')}` : '';
  const text = el.text ? ` containing the text "${el.text.slice(0, 80)}"` : '';
  const actionVerb = action === 'fix' ? 'Find the source of and how to fix' : action === 'improve' ? 'Find the source of and how to improve' : 'Find the source of and how to make mobile-responsive';
  const base = `${actionVerb} the ${el.tag} element${el.id ? ` #${el.id}` : ''}${classes}${text} on ${evidence.sourceUrl}.`;
  return instruction ? `${base} ${instruction}` : base;
}

/** Maps a Phase 9 AskError (see repository-ai-service.ts) onto this feature's own error taxonomy — same relabeling posture repository-ai-service.ts itself uses for SearchError. */
function mapAskErrorCode(code: string): ElementActionErrorCode {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'REPOSITORY_ACCESS_DENIED':
    case 'REPOSITORY_NOT_READY':
    case 'EMBEDDINGS_NOT_READY':
      return 'REPOSITORY_NOT_READY';
    case 'LLM_TIMEOUT':
      return 'LLM_TIMEOUT';
    case 'LLM_PROVIDER_UNAVAILABLE':
      return 'LLM_PROVIDER_UNAVAILABLE';
    default:
      return 'ACTION_FAILED';
  }
}

/** Codes that mean "there's no usable repository for this" — falls back to browser-only rather than failing the whole action. Anything else (a real embedding/LLM/service failure) surfaces as a real error instead of silently degrading. */
const FALLBACK_TO_BROWSER_ONLY = new Set(['REPOSITORY_NOT_READY']);

async function answerBrowserOnly(
  evidence: ComponentEvidence,
  action: ElementActionType,
  instruction: string | undefined,
  deps: ElementActionDeps,
  signal?: AbortSignal,
): Promise<ElementActionResponse> {
  const blockReason = detectBlockingSensitiveContent(evidence);
  if (blockReason) {
    throw new ElementActionError(`This selection contains ${blockReason}, which can't be safely analyzed.`, 'EVIDENCE_BLOCKED');
  }

  const scrubbed = sanitizeComponentEvidence(evidence);
  const contextText = buildElementQaContext({ url: scrubbed.sourceUrl, pageTitle: scrubbed.pageTitle, evidence: scrubbed });

  try {
    const result = await deps.qaProvider.answer({ action, contextText, instruction }, signal);
    return { action, answer: result.answer, groundedInRepository: false, model: result.model };
  } catch (error) {
    if (error instanceof ElementQaProviderError) throw new ElementActionError(error.message, error.category);
    throw new ElementActionError('Element action failed unexpectedly.', 'ACTION_FAILED');
  }
}

/**
 * Orchestrates "Select Anything" element actions. "explain"/"improve"/
 * "make_responsive" without a repositoryId, and "fix" without one, are
 * always browser-only. When repositoryId IS supplied, this reuses Phase 9's
 * answerRepositoryQuestion (search -> rerank -> grounded Q&A) UNCHANGED,
 * with a query built from the element's evidence instead of a user-typed
 * one — never a second, parallel source-grounding system. If the
 * repository isn't usable yet, this falls back to the browser-only path
 * rather than failing the whole action (see FALLBACK_TO_BROWSER_ONLY).
 */
export async function answerElementAction(
  evidence: ComponentEvidence,
  action: ElementActionType,
  instruction: string | undefined,
  repositoryId: string | undefined,
  deps: ElementActionDeps,
  repoLookup?: {
    repository: { id: string; ownerId?: string; status: string } | undefined;
    stores: RepositoryAskStores;
    ownerId?: string;
    providerDeps: AskProviderDeps;
  },
  signal?: AbortSignal,
): Promise<ElementActionResponse> {
  validateEvidence(evidence);

  if (repositoryId && repoLookup) {
    try {
      const query = buildElementSearchQuery(evidence, action, instruction);
      const params: AskRequestParams = { repositoryId, ownerId: repoLookup.ownerId, query };
      const result = await answerRepositoryQuestion(repoLookup.repository, repoLookup.stores, params, repoLookup.providerDeps, signal);
      return { action, answer: result.answer, groundedInRepository: true, model: result.model };
    } catch (error) {
      if (error instanceof AskError) {
        const code = mapAskErrorCode(error.code);
        if (!FALLBACK_TO_BROWSER_ONLY.has(code)) throw new ElementActionError(error.message, code);
        // else: fall through to the browser-only path below.
      } else {
        throw error;
      }
    }
  }

  return answerBrowserOnly(evidence, action, instruction, deps, signal);
}
