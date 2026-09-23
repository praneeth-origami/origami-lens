/**
 * Repository issue analysis + AI fix proposal (Phase 8) — deliberately
 * isolated from gateway.ts's OrigamiAiGateway/TASK_MODEL_MAP/AiTask exactly
 * the way embedding-provider.ts and reranker-provider.ts already are:
 * gateway.ts is not modified, `AiTask` is not extended, and neither task
 * here is ever routed through /gateway. Both tasks in this file are plain
 * text chat-completion calls against the SAME underlying text model server
 * gateway.ts already uses for explain_issue/ask/etc (AI_TEXT_MODEL via
 * VLLM_BASE_URL) — reusing that model server is not the same as reusing
 * gateway.ts's task routing/timeout/prompt behavior, none of which this
 * file touches.
 *
 * Two distinct tasks, two distinct prompts, two distinct dedicated timeout
 * budgets — never shared with AI_MODEL_TIMEOUT_MS, AI_CODE_GENERATION_TIMEOUT_MS,
 * AI_EMBED_TIMEOUT_MS, or AI_RERANKER_TIMEOUT_MS.
 */

export class RepositoryAiUnavailableError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'RepositoryAiUnavailableError';
  }
}

export class RepositoryAiInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryAiInvalidResponseError';
  }
}

export class RepositoryAiTimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'RepositoryAiTimeoutError';
  }
}

export class RepositoryAiCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryAiCancelledError';
  }
}

export interface RepositoryAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  analysisTimeoutMs: number;
  proposalTimeoutMs: number;
  analysisMaxTokens: number;
  proposalMaxTokens: number;
}

function parsePositiveInt(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/**
 * Own, independent config resolution — never reads VLLM_BASE_URL/AI_TEXT_MODEL
 * through gateway.ts's OrigamiAiGateway; resolves the same underlying
 * variables directly so this module has zero import-time dependency on
 * gateway.ts. AI_ISSUE_ANALYSIS_TIMEOUT_MS/AI_FIX_PROPOSAL_TIMEOUT_MS are
 * each their own dedicated budget (see the Phase 8 report's evidence-limits
 * section for the reasoning behind the specific default values).
 */
export function resolveRepositoryAiConfig(overrides?: Partial<RepositoryAiConfig>): RepositoryAiConfig {
  return {
    baseUrl: overrides?.baseUrl ?? process.env.VLLM_BASE_URL ?? 'http://localhost:8000/v1',
    apiKey: overrides?.apiKey ?? process.env.VLLM_API_KEY ?? 'not-needed',
    model: overrides?.model ?? process.env.AI_TEXT_MODEL ?? 'qwen2.5:7b',
    // A repository issue's evidence (title/description/bounded code chunks)
    // is comparable in size to explain_issue's payload, but the model must
    // reason across multiple chunks rather than one issue record — sized
    // between AI_MODEL_TIMEOUT_MS's chat-task default (45-140s) and
    // generate_component's much larger budget, since output here (a
    // structured analysis object) is far smaller than generated source code.
    analysisTimeoutMs: overrides?.analysisTimeoutMs ?? parsePositiveInt(process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS, 60_000),
    // Fix proposals additionally generate unified-diff text, which can
    // legitimately run longer than a plain analysis for a multi-file change
    // — given a slightly larger budget, still far below generate_component's
    // 180s (Phase 8 proposals are deliberately small: REPOSITORY_FIX_MAX_FILES).
    proposalTimeoutMs: overrides?.proposalTimeoutMs ?? parsePositiveInt(process.env.AI_FIX_PROPOSAL_TIMEOUT_MS, 90_000),
    analysisMaxTokens: overrides?.analysisMaxTokens ?? parsePositiveInt(process.env.AI_ISSUE_ANALYSIS_MAX_TOKENS, 1536),
    proposalMaxTokens: overrides?.proposalMaxTokens ?? parsePositiveInt(process.env.AI_FIX_PROPOSAL_MAX_TOKENS, 3072),
  };
}

export interface EvidenceChunk {
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface IssueAnalysisRequest {
  title: string;
  description: string;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  evidence: EvidenceChunk[];
}

export interface IssueAnalysisResult {
  model: string;
  summary: string;
  rootCause: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  affectedFiles: string[];
  affectedSymbols: string[];
  reasoning: string;
  recommendedFix: string;
  validationPlan: string;
}

export interface FixProposalRequest {
  title: string;
  description: string;
  analysis: IssueAnalysisResult;
  evidence: EvidenceChunk[];
}

export interface FixProposalFileResult {
  filePath: string;
  changeType: 'MODIFIED' | 'ADDED' | 'DELETED';
  diff: string;
}

export interface FixProposalResult {
  model: string;
  summary: string;
  files: FixProposalFileResult[];
}

function extractJsonPayload(raw: string): string {
  let text = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();
  if (text.startsWith('{') && text.endsWith('}')) return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

function buildEvidenceBlock(evidence: EvidenceChunk[]): string {
  return evidence
    .map((chunk, i) => `[Evidence ${i + 1}] File: ${chunk.filePath}\nLanguage: ${chunk.language}\nSymbol: ${chunk.symbol} (${chunk.symbolType})\nLines: ${chunk.startLine}-${chunk.endLine}\n\n${chunk.content}`)
    .join('\n\n---\n\n');
}

async function callChatCompletion(
  config: RepositoryAiConfig,
  systemPrompt: string,
  userContent: string,
  timeoutMs: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: combinedSignal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new RepositoryAiTimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
    }
    if (signal?.aborted && !timeoutSignal.aborted) {
      throw new RepositoryAiCancelledError('Request cancelled by caller');
    }
    throw new RepositoryAiUnavailableError(error instanceof Error ? error.message : 'AI provider unreachable');
  }

  if (!response.ok) {
    const rawDetail = await response.text().catch(() => '');
    const detail = rawDetail.length > 300 ? `${rawDetail.slice(0, 300)}…` : rawDetail;
    throw new RepositoryAiUnavailableError(`AI request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, response.status);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(extractJsonPayload(content)) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Invalid JSON';
    throw new RepositoryAiInvalidResponseError(`AI response was not valid JSON (length=${content.length}): ${reason}`);
  }
}

const CONFIDENCE_VALUES = new Set(['LOW', 'MEDIUM', 'HIGH']);

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Analyzes one repository issue against a bounded set of already-indexed
 * code evidence. Never asked to fix/generate/execute anything — this task's
 * only job is diagnosis. The system prompt explicitly requires the model to
 * separate confirmed evidence from inference and to never claim high
 * confidence without evidence support (see the Phase 8 report's AI-contract
 * section) — enforced here by rejecting a malformed/incomplete response,
 * not by trusting the model to self-police.
 */
export async function analyzeRepositoryIssue(config: RepositoryAiConfig, request: IssueAnalysisRequest, signal?: AbortSignal): Promise<IssueAnalysisResult> {
  const systemPrompt = [
    'You are a code analysis assistant for Origami Lens. You diagnose a reported repository issue using ONLY the evidence provided below — indexed code chunks from the repository at one specific commit.',
    'Do not invent files, symbols, or behavior not present in the evidence. Clearly separate what the evidence actually confirms from what you are inferring.',
    'If the evidence is insufficient to determine a root cause, say so explicitly and use confidence "LOW" — never claim a fix is correct when the evidence does not support it.',
    'Respond ONLY with a single JSON object, no markdown fences, no extra text, exactly this shape:',
    '{"summary":"","rootCause":"","confidence":"LOW|MEDIUM|HIGH","affectedFiles":[""],"affectedSymbols":[""],"reasoning":"","recommendedFix":"","validationPlan":""}',
  ].join(' ');

  const userContent = [
    `Issue title: ${request.title}`,
    `Issue description: ${request.description}`,
    request.filePath ? `Reported file: ${request.filePath}` : '',
    request.symbol ? `Reported symbol: ${request.symbol}` : '',
    request.lineStart !== undefined ? `Reported lines: ${request.lineStart}-${request.lineEnd ?? request.lineStart}` : '',
    '',
    'Evidence (indexed repository code):',
    buildEvidenceBlock(request.evidence),
  ].filter(Boolean).join('\n');

  const data = await callChatCompletion(config, systemPrompt, userContent, config.analysisTimeoutMs, config.analysisMaxTokens, signal);

  const confidence = typeof data.confidence === 'string' && CONFIDENCE_VALUES.has(data.confidence) ? (data.confidence as IssueAnalysisResult['confidence']) : undefined;
  if (typeof data.summary !== 'string' || typeof data.rootCause !== 'string' || !confidence || typeof data.reasoning !== 'string') {
    throw new RepositoryAiInvalidResponseError('AI analysis response was missing required fields (summary/rootCause/confidence/reasoning)');
  }

  return {
    model: config.model,
    summary: data.summary,
    rootCause: data.rootCause,
    confidence,
    affectedFiles: asStringArray(data.affectedFiles),
    affectedSymbols: asStringArray(data.affectedSymbols),
    reasoning: data.reasoning,
    recommendedFix: typeof data.recommendedFix === 'string' ? data.recommendedFix : '',
    validationPlan: typeof data.validationPlan === 'string' ? data.validationPlan : '',
  };
}

const CHANGE_TYPES = new Set(['MODIFIED', 'ADDED', 'DELETED']);

/**
 * Generates a proposed unified-diff fix from a completed analysis. Never
 * asked to run/execute/validate anything against a live checkout — the
 * caller (repository-fix-service.ts) is solely responsible for statically
 * validating whatever this returns before it is ever shown to a user, per
 * the Phase 8 report's diff-validation section. This function itself never
 * writes to any filesystem.
 */
export async function proposeRepositoryFix(config: RepositoryAiConfig, request: FixProposalRequest, signal?: AbortSignal): Promise<FixProposalResult> {
  const systemPrompt = [
    'You are a code-fix assistant for Origami Lens. Given a diagnosed repository issue and its analysis, propose a minimal, reviewable fix as a unified diff.',
    'Only propose changes to files that appear in the evidence below — never invent a file path that is not shown. Prefer modifying existing files over adding or deleting files.',
    'This is a REVIEW-ONLY proposal: it will never be applied automatically. Do not include any explanation of how to run, build, or deploy anything — only the diff and a short summary.',
    'Respond ONLY with a single JSON object, no markdown fences, no extra text, exactly this shape:',
    '{"summary":"","files":[{"filePath":"","changeType":"MODIFIED|ADDED|DELETED","diff":"--- a/path\\n+++ b/path\\n@@ ...\\n- old\\n+ new"}]}',
  ].join(' ');

  const userContent = [
    `Issue title: ${request.title}`,
    `Issue description: ${request.description}`,
    '',
    'Analysis:',
    `Summary: ${request.analysis.summary}`,
    `Root cause: ${request.analysis.rootCause}`,
    `Confidence: ${request.analysis.confidence}`,
    `Recommended fix: ${request.analysis.recommendedFix}`,
    '',
    'Evidence (indexed repository code — only these files may be referenced):',
    buildEvidenceBlock(request.evidence),
  ].join('\n');

  const data = await callChatCompletion(config, systemPrompt, userContent, config.proposalTimeoutMs, config.proposalMaxTokens, signal);

  if (typeof data.summary !== 'string' || !Array.isArray(data.files)) {
    throw new RepositoryAiInvalidResponseError('AI fix proposal response was missing required fields (summary/files)');
  }

  const files: FixProposalFileResult[] = [];
  for (const raw of data.files as unknown[]) {
    const entry = raw as { filePath?: unknown; changeType?: unknown; diff?: unknown };
    if (typeof entry.filePath !== 'string' || typeof entry.diff !== 'string') {
      throw new RepositoryAiInvalidResponseError('AI fix proposal contained a file entry missing filePath/diff');
    }
    const changeType = typeof entry.changeType === 'string' && CHANGE_TYPES.has(entry.changeType) ? (entry.changeType as FixProposalFileResult['changeType']) : 'MODIFIED';
    files.push({ filePath: entry.filePath, changeType, diff: entry.diff });
  }

  return { model: config.model, summary: data.summary, files };
}
