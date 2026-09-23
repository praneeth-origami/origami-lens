import type { RepositoryFixChangeType } from '@origami/contracts';
import type { EvidenceChunkInput, IssueAnalysisProviderResult } from './repository-issue-analysis-provider.js';

/** Talks to the AI Router's dedicated POST /propose-repository-fix route — mirrors HttpIssueAnalysisProvider's relationship to POST /analyze-repository-issue exactly. */
export interface FixProposalProvider {
  proposeFix(request: FixProposalProviderRequest, signal?: AbortSignal): Promise<FixProposalProviderResult>;
}

export interface FixProposalProviderRequest {
  title: string;
  description: string;
  analysis: IssueAnalysisProviderResult;
  evidence: EvidenceChunkInput[];
}

export interface FixProposalProviderFile {
  filePath: string;
  changeType: RepositoryFixChangeType;
  diff: string;
}

export interface FixProposalProviderResult {
  model: string;
  summary: string;
  files: FixProposalProviderFile[];
}

export class FixProposalProviderError extends Error {
  constructor(message: string, public readonly category: 'PROPOSAL_PROVIDER_UNAVAILABLE' | 'PROPOSAL_TIMEOUT' | 'PROPOSAL_FAILED') {
    super(message);
    this.name = 'FixProposalProviderError';
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

/** Its own dedicated budget — kept slightly above the AI Router's own AI_FIX_PROPOSAL_TIMEOUT_MS default (90s). */
export const AI_FIX_PROPOSAL_CLIENT_TIMEOUT_MS = envInt('AI_FIX_PROPOSAL_CLIENT_TIMEOUT_MS', 95_000);

export class HttpFixProposalProvider implements FixProposalProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env.AI_ROUTER_URL ?? 'http://localhost:3102';
    this.timeoutMs = options.timeoutMs ?? AI_FIX_PROPOSAL_CLIENT_TIMEOUT_MS;
  }

  async proposeFix(request: FixProposalProviderRequest, signal?: AbortSignal): Promise<FixProposalProviderResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/propose-repository-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new FixProposalProviderError(`Fix proposal request timed out after ${this.timeoutMs}ms`, 'PROPOSAL_TIMEOUT');
      }
      if (signal?.aborted && !timeoutSignal.aborted) {
        throw new FixProposalProviderError('Fix proposal request cancelled by caller', 'PROPOSAL_FAILED');
      }
      throw new FixProposalProviderError(error instanceof Error ? error.message : 'Fix proposal provider unreachable', 'PROPOSAL_PROVIDER_UNAVAILABLE');
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const message = typeof body.error === 'string' ? body.error : `Fix proposal request failed: HTTP ${response.status}`;
      const category = response.status === 504 ? 'PROPOSAL_TIMEOUT' : 'PROPOSAL_PROVIDER_UNAVAILABLE';
      throw new FixProposalProviderError(message, category);
    }

    const data = (await response.json().catch(() => null)) as FixProposalProviderResult | null;
    if (!data || typeof data.summary !== 'string' || !Array.isArray(data.files)) {
      throw new FixProposalProviderError('Fix proposal response was malformed', 'PROPOSAL_FAILED');
    }
    return data;
  }
}
