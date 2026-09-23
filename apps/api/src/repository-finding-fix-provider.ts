import type { RepositoryFixProposalErrorCode } from '@origami/contracts';

/**
 * Talks to the AI Router's dedicated POST /propose-finding-fix route
 * (services/ai-router/src/index.ts), never to a model server directly and
 * never to /gateway — mirrors HttpRepositoryQaProvider's (Phase 9) and
 * HttpIssueAnalysisProvider's (Phase 8) relationship to their own AI
 * Router routes exactly. repository-finding-fix-service.ts depends only on
 * this interface, never on fetch/HTTP directly.
 */
export interface FindingFixProvider {
  proposeFix(request: FindingFixProviderRequest, signal?: AbortSignal): Promise<FindingFixProviderResult>;
}

export interface FindingFixProviderRequest {
  contextText: string;
  instruction?: string;
}

export interface FindingFixProviderHunk {
  startLine?: number;
  endLine?: number;
  oldText?: string;
  newText?: string;
}

export interface FindingFixProviderChange {
  filePath?: string;
  language?: string;
  hunks?: FindingFixProviderHunk[];
}

export interface FindingFixProviderResult {
  model: string;
  status: 'PROPOSED' | 'INSUFFICIENT_EVIDENCE';
  summary: string;
  reasoning: string;
  /** Raw, UNVALIDATED shape from the AI Router — repository-finding-fix-service.ts's validateFindingFixProposal() is solely responsible for validating every field before this is ever trusted. */
  changes: FindingFixProviderChange[];
}

export class FindingFixProviderError extends Error {
  constructor(message: string, public readonly category: RepositoryFixProposalErrorCode) {
    super(message);
    this.name = 'FindingFixProviderError';
  }
}

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

/** Its own dedicated budget — kept slightly above the AI Router's own AI_REPOSITORY_FIX_TIMEOUT_MS default (90s), same pattern as Phase 8/9's *_CLIENT_TIMEOUT_MS variables. */
export const AI_REPOSITORY_FIX_CLIENT_TIMEOUT_MS = envInt('AI_REPOSITORY_FIX_CLIENT_TIMEOUT_MS', 95_000);

/**
 * Bugfix: the AI Router's /propose-finding-fix route (services/ai-router/src/index.ts)
 * already distinguishes these failure modes correctly and sends its own
 * `errorCategory` in the response body — but this client used to ignore it
 * entirely and collapse EVERY non-2xx, non-504 response into
 * LLM_PROVIDER_UNAVAILABLE. That meant a real, reachable LLM that returned
 * a malformed/truncated response (HTTP 502, errorCategory
 * "LLM_INVALID_RESPONSE") was misreported to callers as "the provider is
 * unavailable" — actively misleading, since the provider was reachable and
 * responded. `errorCategory` is read first and mapped 1:1 where a matching
 * contract code exists; only when it's missing (an older/different AI
 * Router build) or unrecognized does this fall back to the previous
 * status-code heuristic, so this stays compatible either way.
 */
function mapUpstreamErrorCategory(errorCategory: unknown, httpStatus: number): RepositoryFixProposalErrorCode {
  switch (errorCategory) {
    case 'LLM_TIMEOUT':
      return 'LLM_TIMEOUT';
    case 'LLM_INVALID_RESPONSE':
      return 'LLM_INVALID_RESPONSE';
    case 'PROPOSAL_CANCELLED':
      // Distinct from "provider unavailable" — the request was reachable
      // and the AI Router itself cancelled it — but this contract has no
      // dedicated cancellation code today; FIX_PROPOSAL_FAILED is the
      // existing generic non-availability bucket, same as the local
      // caller-aborted branch above already uses.
      return 'FIX_PROPOSAL_FAILED';
    case 'LLM_PROVIDER_UNAVAILABLE':
      return 'LLM_PROVIDER_UNAVAILABLE';
    default:
      return httpStatus === 504 ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE';
  }
}

export class HttpFindingFixProvider implements FindingFixProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_REPOSITORY_FIX_CLIENT_TIMEOUT_MS;
  }

  async proposeFix(request: FindingFixProviderRequest, signal?: AbortSignal): Promise<FindingFixProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/propose-finding-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new FindingFixProviderError(`Finding fix-proposal request timed out after ${this.timeoutMs}ms`, 'LLM_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new FindingFixProviderError('Finding fix-proposal request cancelled by caller', 'FIX_PROPOSAL_FAILED');
      }
      throw new FindingFixProviderError(error instanceof Error ? error.message : 'Finding fix-proposal provider unreachable', 'LLM_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; errorCategory?: unknown };
      const message = typeof body.error === 'string' ? body.error : `Finding fix-proposal request failed: HTTP ${response.status}`;
      throw new FindingFixProviderError(message, mapUpstreamErrorCategory(body.errorCategory, response.status));
    }

    const data = (await response.json().catch(() => null)) as FindingFixProviderResult | null;
    if (!data || (data.status !== 'PROPOSED' && data.status !== 'INSUFFICIENT_EVIDENCE') || typeof data.summary !== 'string') {
      throw new FindingFixProviderError('Finding fix-proposal response was malformed', 'FIX_PROPOSAL_FAILED');
    }
    return { ...data, changes: Array.isArray(data.changes) ? data.changes : [] };
  }
}
