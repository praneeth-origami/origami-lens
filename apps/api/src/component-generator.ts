import type {
  CodeTarget,
  ComponentAssetRef,
  ComponentDomNode,
  ComponentEvidence,
  ComponentGenerationStatus,
  ComponentVerification,
  GeneratedComponentResult,
  GeneratedFile,
  GenerationErrorCategory,
} from '@origami/contracts';
import { CODE_TARGET_META } from '@origami/contracts';
import { detectBlockingSensitiveContent, sanitizeComponentEvidence, scrubString } from '@origami/privacy';
import { verifyGeneratedComponent } from '@origami/verification';

const AI_ROUTER_URL = process.env.AI_ROUTER_URL ?? 'http://localhost:3102';

const PLACEHOLDER_NAMES = new Set(['component1', 'testcomponent', 'aicomponent', 'component']);
const MAX_HTML_CHARS = 20_000;
const MAX_TREE_DEPTH = 4;
const MAX_CHILDREN_PER_NODE = 25;

/**
 * Root-caused via a real Ollama rejection for the currently configured
 * vision model (qwen3-vl:8b-instruct): "request (4879 tokens) exceeds the
 * available context size (4096 tokens)". The existing MAX_HTML_CHARS/
 * MAX_TREE_DEPTH/MAX_CHILDREN_PER_NODE trimming above bounds tree shape but
 * never the resulting token count — a real page's `cssVariables` (often
 * unbounded — many sites define dozens to hundreds of custom properties at
 * :root) and per-node `attributes` can inflate the serialized evidence well
 * past what those shape limits alone prevent. This is a token-budget guard
 * specifically for the screenshot_to_code call, independent of and in
 * addition to that existing trimming — generate_component's own evidence
 * (trimmedElement/trimmedHtml below) is untouched by any of this.
 *
 * No tokenizer dependency is introduced — nothing in this project already
 * depends on one, and adding one solely for this estimate would be
 * disproportionate. Instead this is a deliberately conservative
 * character-count heuristic: every reserve below is sized to overestimate
 * cost (bias toward LESS available budget), because the failure mode this
 * fix closes is exactly the opposite mistake (assuming more room existed
 * than actually did).
 */
const VISION_MODEL_CONTEXT_TOKENS = 4096; // observed directly from the real Ollama error for the currently configured vision model
/** The fixed screenshot_to_code system prompt + its JSON-schema instructions (gateway.ts) is roughly 150-180 words; rounded generously upward. */
const VISION_SYSTEM_PROMPT_TOKEN_RESERVE = 250;
/**
 * The request also includes the screenshot itself — a vision model spends
 * real context tokens encoding an image, not zero. There is no way to know
 * the exact cost without the model's own image tokenizer (out of scope to
 * add), so this reserve is deliberately generous rather than precise.
 */
const VISION_IMAGE_TOKEN_RESERVE = 1000;
/**
 * The actual Ollama error compared prompt tokens directly against n_ctx
 * ("n_prompt_tokens":4879 vs "n_ctx":4096) — a prompt-only pre-check, not
 * prompt+completion combined, so this is a modest allowance for protocol
 * uncertainty (a different server/version might count differently), not a
 * full reservation of gateway.ts's 2048-token screenshot_to_code output cap.
 */
const VISION_OUTPUT_TOKEN_RESERVE = 256;
/** Explicit extra buffer so the target is never the ceiling itself, per the requirement to leave a safety margin and never target exactly 4096. */
const VISION_CONTEXT_SAFETY_MARGIN_TOKENS = 200;

export const VISION_EVIDENCE_TOKEN_BUDGET =
  VISION_MODEL_CONTEXT_TOKENS
  - VISION_SYSTEM_PROMPT_TOKEN_RESERVE
  - VISION_IMAGE_TOKEN_RESERVE
  - VISION_OUTPUT_TOKEN_RESERVE
  - VISION_CONTEXT_SAFETY_MARGIN_TOKENS;

/**
 * Conservative characters-per-token ratio used only to estimate token count
 * from string length (no real tokenizer). JSON-like structured text (heavy
 * on punctuation, quotes, camelCase identifiers) tends to tokenize LESS
 * efficiently than prose, so this deliberately UNDERestimates characters
 * per token — which OVERestimates the resulting token count, biasing every
 * budget check toward the safe/conservative side.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Deterministic, stable-order cap on a string-keyed record — keeps the first `cap` entries (insertion order), never a random subset. */
function capRecord(record: Record<string, string>, cap: number): Record<string, string> {
  if (cap <= 0) return {};
  const entries = Object.entries(record);
  if (entries.length <= cap) return record;
  return Object.fromEntries(entries.slice(0, cap));
}

export interface VisionEvidencePayload {
  element: ComponentDomNode;
  ancestors: ComponentDomNode[];
  cssVariables: Record<string, string>;
  assets: ComponentAssetRef[];
  /** True if any reduction stage beyond the existing baseline trimming had to run. Internal-only — never persisted or exposed externally. */
  evidenceTruncated: boolean;
}

/**
 * Structured, shape-only diagnostic for when the vision evidence needed
 * additional reduction beyond the existing baseline trimming — deliberately
 * excludes all screenshot/DOM/CSS content, matching the same safety
 * discipline as logComponentOutputParseFailure below.
 */
function logVisionEvidenceTruncated(target: CodeTarget, safe: ComponentEvidence, final: VisionEvidencePayload, finalEstimatedTokens: number): void {
  console.error(JSON.stringify({
    event: 'vision_evidence_truncated',
    target,
    originalAssetCount: safe.assets.length,
    originalCssVariableCount: Object.keys(safe.cssVariables).length,
    originalAncestorCount: safe.ancestors.length,
    finalAssetCount: final.assets.length,
    finalCssVariableCount: Object.keys(final.cssVariables).length,
    finalAncestorCount: final.ancestors.length,
    estimatedTokens: finalEstimatedTokens,
    budgetTokens: VISION_EVIDENCE_TOKEN_BUDGET,
  }));
}

/**
 * Builds the DOM/CSS evidence sent alongside the screenshot to
 * screenshot_to_code, deterministically reduced — never blindly
 * string-sliced — until its estimated token cost fits within
 * VISION_EVIDENCE_TOKEN_BUDGET. Reduction only ever removes array entries
 * or object keys (never truncates a string mid-value), so the result is
 * always complete, valid JSON, never malformed.
 *
 * Reduction order (least valuable to reproducing structure, first):
 *   1. CSS variables       4. DOM tree depth
 *   2. assets metadata     5. ancestor count (selected element always kept)
 *   3. DOM tree breadth
 * The selected element itself is never dropped, and its own attributes/
 * style are only reduced at the very end, after everything else has
 * already been minimized — by which point ancestors and cssVariables/
 * assets are already gone, so this stage is reached only for a genuinely
 * pathological single node (see the "very large DOM" test).
 */
export function buildVisionEvidence(safe: ComponentEvidence, target: CodeTarget): VisionEvidencePayload {
  let element = trimNode(safe.element, 0, MAX_TREE_DEPTH, MAX_CHILDREN_PER_NODE);
  let ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, MAX_TREE_DEPTH - 1, MAX_CHILDREN_PER_NODE));
  let cssVariables = safe.cssVariables;
  let assets = safe.assets.slice(0, 20);

  const estimate = () => estimateTokens(JSON.stringify({ element, ancestors, cssVariables, assets }));
  let tokens = estimate();
  if (tokens <= VISION_EVIDENCE_TOKEN_BUDGET) {
    return { element, ancestors, cssVariables, assets, evidenceTruncated: false };
  }

  const stages: Array<() => void> = [
    // 1. CSS variables — progressively.
    () => { cssVariables = capRecord(safe.cssVariables, 40); },
    () => { cssVariables = capRecord(safe.cssVariables, 15); },
    () => { cssVariables = capRecord(safe.cssVariables, 5); },
    () => { cssVariables = {}; },
    // 2. Assets — progressively.
    () => { assets = safe.assets.slice(0, 8); },
    () => { assets = safe.assets.slice(0, 2); },
    () => { assets = []; },
    // 3. DOM tree breadth — fewer children per node, still same depth.
    () => { element = trimNode(safe.element, 0, MAX_TREE_DEPTH, 10); ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, MAX_TREE_DEPTH - 1, 10)); },
    () => { element = trimNode(safe.element, 0, MAX_TREE_DEPTH, 4); ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, MAX_TREE_DEPTH - 1, 4)); },
    () => { element = trimNode(safe.element, 0, MAX_TREE_DEPTH, 0); ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, MAX_TREE_DEPTH - 1, 0)); },
    // 4. DOM tree depth — shallower, breadth already minimal.
    () => { element = trimNode(safe.element, 0, 2, 0); ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, 1, 0)); },
    () => { element = trimNode(safe.element, 0, 0, 0); ancestors = safe.ancestors.slice(0, 5).map((a) => trimNode(a, 0, 0, 0)); },
    // 5. Ancestor count — the selected element itself is never removed here, only its context.
    () => { ancestors = safe.ancestors.slice(0, 2).map((a) => trimNode(a, 0, 0, 0)); },
    () => { ancestors = []; },
  ];

  for (const applyStage of stages) {
    applyStage();
    tokens = estimate();
    if (tokens <= VISION_EVIDENCE_TOKEN_BUDGET) break;
  }

  logVisionEvidenceTruncated(target, safe, { element, ancestors, cssVariables, assets, evidenceTruncated: true }, tokens);
  return { element, ancestors, cssVariables, assets, evidenceTruncated: true };
}

export interface GenerationOutcome {
  status: ComponentGenerationStatus;
  componentName?: string;
  result?: GeneratedComponentResult;
  verification?: ComponentVerification;
  aiAvailable: boolean;
  error?: string;
  errorCategory?: GenerationErrorCategory;
}

interface GatewayResponse {
  success: boolean;
  model?: string;
  result?: Record<string, unknown>;
  error?: string;
  errorCategory?: GenerationErrorCategory;
}

/**
 * `maxDepth`/`maxChildren` default to the existing module-level constants so
 * every pre-existing call site (generate_component's evidence, unrelated to
 * this fix) behaves exactly as before. The vision-evidence budgeting below
 * passes progressively smaller explicit caps through these same two
 * parameters instead of introducing a second tree-trimming implementation.
 */
function trimNode(node: ComponentDomNode, depth = 0, maxDepth: number = MAX_TREE_DEPTH, maxChildren: number = MAX_CHILDREN_PER_NODE): ComponentDomNode {
  return {
    ...node,
    children: depth >= maxDepth
      ? []
      : node.children.slice(0, maxChildren).map((c) => trimNode(c, depth + 1, maxDepth, maxChildren)),
  };
}

function nameFromNode(node: ComponentDomNode): string {
  const identity = `${node.id ?? ''} ${(node.classList ?? []).join(' ')}`.toLowerCase();
  if (node.tag === 'nav' || /\bnav(bar)?\b|menu/.test(identity)) return 'Navbar';
  if (node.tag === 'footer' || identity.includes('footer')) return 'Footer';
  if (identity.includes('pricing')) return 'PricingCard';
  if (identity.includes('product')) return 'ProductCard';
  if (identity.includes('hero')) return 'HeroSection';
  if (node.tag === 'form') return 'ContactForm';
  if (identity.includes('card')) return 'Card';
  return 'GeneratedComponent';
}

function isUsableName(name: string | undefined): name is string {
  return Boolean(name && name.trim() && !PLACEHOLDER_NAMES.has(name.trim().toLowerCase()));
}

/**
 * If the AI Router process itself (not just the underlying model server it
 * proxies to) is unreachable, `fetch` throws here — that's a distinct failure
 * layer from gateway.ts's own "model unavailable" handling, which never runs
 * in that case since the ai-router process isn't handling the request at
 * all. Both layers get their own structured log and the same safe, generic,
 * user-facing message — never a raw "fetch failed"-style error.
 */
// Configurable via AI_GATEWAY_TIMEOUT_MS. Must exceed gateway.ts's own
// AI_MODEL_TIMEOUT_MS (per-provider default 140s for Ollama) — otherwise this
// outer timeout fires first, the caller gives up and reports failure, while
// the AI Router is still legitimately waiting on a slow/cold model load that
// may well have succeeded moments later. An outer timeout must never be
// tighter than the inner one it wraps.
const DEFAULT_GATEWAY_CALL_TIMEOUT_MS = 150_000;
/** Only zero/negative/non-finite is rejected as unsafe — a deliberately small positive value (e.g. in tests) is a legitimate, if unusual, configuration, not an error. */
const MIN_GATEWAY_CALL_TIMEOUT_MS = 1;

/**
 * A misconfigured timeout (zero, negative, NaN, or absurdly small) would
 * fire before a single AI Gateway round trip could complete — worse than no
 * override at all. Falls back to the safe default and logs why, instead of
 * crashing or silently running with a nonsensical value.
 */
function validatedTimeoutMs(envValue: string | undefined, defaultMs: number, minMs: number, label: string): number {
  if (envValue === undefined || envValue === '') return defaultMs;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < minMs) {
    console.error(JSON.stringify({ event: 'invalid_timeout_config', label, providedValue: envValue, minMs, fallbackMs: defaultMs }));
    return defaultMs;
  }
  return parsed;
}

const GATEWAY_CALL_TIMEOUT_MS = validatedTimeoutMs(process.env.AI_GATEWAY_TIMEOUT_MS, DEFAULT_GATEWAY_CALL_TIMEOUT_MS, MIN_GATEWAY_CALL_TIMEOUT_MS, 'AI_GATEWAY_TIMEOUT_MS');

/**
 * `externalSignal` is the job-level cancellation signal (user Stop Generation
 * click, or the worker's overall-duration timeout) — combined with this
 * call's own per-stage timeout so either one can interrupt the in-flight
 * fetch. This is real cancellation of the actual outbound HTTP request to
 * the AI Gateway, not just a UI-side "stop waiting" — aborting here means
 * the AI Gateway's own request to the model server also gets its connection
 * dropped, so no further model work is billed/occupies the model server
 * once this fires (see gateway.ts's `AI_MODEL_TIMEOUT_MS` handling for the
 * one nuance: an already-issued inference call to the model server itself
 * cannot always be interrupted mid-token-generation — documented in the
 * report, not hidden here).
 */
async function callGateway(
  task: 'screenshot_to_code' | 'generate_component',
  payload: Record<string, unknown>,
  externalSignal?: AbortSignal,
): Promise<GatewayResponse> {
  const timeoutSignal = AbortSignal.timeout(GATEWAY_CALL_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

  try {
    const response = await fetch(`${AI_ROUTER_URL}/gateway`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, payload }),
      signal,
    });

    if (!response.ok) {
      // 413 means the AI Router itself was reachable and responded — the
      // request body exceeded its configured bodyLimit (see that service's
      // MAX_REQUEST_BODY_MB) before ever reaching route logic. Distinct
      // failure layer from "unreachable"/"model unavailable", worth its own
      // event name for anyone grepping these logs later, even though the
      // user-facing message stays the same generic, non-leaking text.
      const isPayloadTooLarge = response.status === 413;
      const event = isPayloadTooLarge ? 'ai_gateway_payload_too_large' : 'ai_gateway_unreachable';
      console.error(JSON.stringify({ event, task, statusCode: response.status }));
      return {
        success: false,
        error: 'Code generation is temporarily unavailable.',
        errorCategory: isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : 'NETWORK_ERROR',
      };
    }
    return (await response.json()) as GatewayResponse;
  } catch (error) {
    // This outer timeout means the AI Router process itself never answered
    // within its own budget (rare — it normally answers with its own
    // classified error well before this fires, see gateway.ts's AiTimeoutError
    // handling). Distinguish it from a genuine connection failure the same
    // way gateway.ts distinguishes a model timeout from model unavailability.
    // A signal that was aborted for OUR OWN reasons (job cancellation/overall
    // timeout, tracked by the caller) is reported as such rather than as a
    // generic network failure — the caller (generate()) re-derives the
    // precise CANCELLED vs TIMED_OUT distinction from its own signal state.
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const isAbort = error instanceof Error && error.name === 'AbortError';
    console.error(JSON.stringify({
      event: isTimeout ? 'ai_gateway_timeout' : isAbort ? 'ai_gateway_request_aborted' : 'ai_gateway_unreachable',
      task,
      reason: error instanceof Error ? error.message : 'AI Gateway request failed',
    }));
    return {
      success: false,
      error: isTimeout ? 'Code generation timed out. Please try again.' : 'Code generation is temporarily unavailable.',
      errorCategory: isTimeout ? 'MODEL_TIMEOUT' : isAbort ? 'USER_CANCELLED' : 'NETWORK_ERROR',
    };
  }
}

/**
 * A model timing out is a timeout regardless of which layer detected it —
 * the job's own overall-duration ceiling (worker.ts's
 * COMPONENT_GENERATION_TIMEOUT_MS) is not the only place a timeout can
 * happen; a single AI Gateway call timing out on its own (AI_MODEL_TIMEOUT_MS,
 * well inside the job-level budget) is just as much a genuine TIMED_OUT, not
 * a generic FAILED. Verified against a real ai-router + Ollama timeout: a
 * job-level FAILED here made TIMED_OUT unreachable for the single most
 * common timeout case.
 */
function statusForFailure(errorCategory: GenerationErrorCategory | undefined): ComponentGenerationStatus {
  return errorCategory === 'MODEL_TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
}

/**
 * Extracts one GeneratedFile from a candidate `files[]` entry, tolerating
 * the key-name variants real model output has been observed to use in
 * place of the canonical `path`/`content` (see the parsing diagnosis: the
 * model returns syntactically valid JSON, just not always these exact
 * names). Anything that isn't unambiguously a {string, string} pair is
 * rejected outright — this stays tolerant of naming, never of shape.
 */
function extractFileEntry(candidate: unknown): GeneratedFile | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const obj = candidate as Record<string, unknown>;
  const rawPath = obj.path ?? obj.filename;
  const rawContent = obj.content ?? obj.code ?? obj.source;
  if (typeof rawPath !== 'string' || typeof rawContent !== 'string') return null;
  const path = rawPath.trim();
  if (!path || !rawContent.trim()) return null;
  return { path, content: rawContent };
}

/** Turns a component name into a safe, plain filename stem for the HTML_CSS direct-shape fallback below — never anything derived from AI-generated file content. */
function filenameStem(componentName: string): string {
  const slug = componentName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'component';
}

/**
 * Structured, shape-only diagnostic for when no usable files could be
 * recovered from the model's response — deliberately excludes all actual
 * content (file contents, HTML/CSS text, DOM/screenshot data) so this is
 * always safe to log, unlike the raw response itself (see callVllm's own
 * doc comment on why that is never logged).
 */
function logComponentOutputParseFailure(target: CodeTarget, raw: unknown): void {
  const isObj = raw !== null && typeof raw === 'object';
  const topLevelKeys = isObj ? Object.keys(raw as Record<string, unknown>) : [];
  const filesValue = isObj ? (raw as Record<string, unknown>).files : undefined;
  const isFilesArray = Array.isArray(filesValue);
  const hasHtml = isObj && typeof (raw as Record<string, unknown>).html === 'string';
  const hasCss = isObj && typeof (raw as Record<string, unknown>).css === 'string';
  console.error(JSON.stringify({
    event: 'component_output_parse_failed',
    target,
    topLevelKeys,
    hasFiles: filesValue !== undefined,
    filesType: typeof filesValue,
    isFilesArray,
    candidateFileCount: isFilesArray ? (filesValue as unknown[]).length : 0,
    fallbackDetected: hasHtml || hasCss ? 'html_css' : null,
  }));
}

/**
 * Canonical shape (primary, always tried first): { files: [{ path, content }] }.
 * Tolerates common equivalent key names within each file entry (filename/code/source).
 * For HTML_CSS only, additionally recognizes a direct { html, css } shape and
 * normalizes it into the same files[] contract — never applied to
 * REACT/NEXT_JS/TAILWIND, whose targetMeta always expects JSX files, so a
 * top-level html/css pair there is not an unambiguous equivalent and is
 * correctly left unrecognized (falls through to the empty-array failure path).
 */
function parseFiles(raw: unknown, target: CodeTarget, componentName: string): GeneratedFile[] {
  const isObj = raw !== null && typeof raw === 'object';
  const filesValue = isObj ? (raw as Record<string, unknown>).files : undefined;

  if (Array.isArray(filesValue)) {
    const files = filesValue.map(extractFileEntry).filter((f): f is GeneratedFile => f !== null);
    if (files.length > 0) return files;
  }

  if (target === 'HTML_CSS' && isObj) {
    const html = (raw as Record<string, unknown>).html;
    const css = (raw as Record<string, unknown>).css;
    if (typeof html === 'string' && html.trim()) {
      const stem = filenameStem(componentName);
      const fallbackFiles: GeneratedFile[] = [{ path: `${stem}.html`, content: html }];
      if (typeof css === 'string' && css.trim()) {
        fallbackFiles.push({ path: `${stem}.css`, content: css });
      }
      return fallbackFiles;
    }
  }

  logComponentOutputParseFailure(target, raw);
  return [];
}

/**
 * Orchestrates the Screenshot -> Code AI pipeline:
 *   Privacy gate -> screenshot_to_code (vision) -> generate_component (coding) -> verification
 * Mirrors the sequential AI Gateway calls already used in page-scan-runner.ts
 * (summarize_scan, visual_qa) — same architecture, same task/payload contract,
 * no direct model calls, no second AI gateway.
 */
export class ComponentGenerator {
  /**
   * `signal`, when provided, lets the caller (the worker, on Stop Generation
   * or the overall-duration timeout) actually interrupt the in-flight AI
   * Gateway request rather than merely abandoning interest in the result —
   * see callGateway's doc comment for exactly what "abort" does and does not
   * guarantee once a model has started generating tokens.
   */
  async generate(sourceUrl: string, target: CodeTarget, evidence: ComponentEvidence, signal?: AbortSignal): Promise<GenerationOutcome> {
    if (signal?.aborted) {
      // Cancelled before this job was even dequeued — make zero AI calls.
      // (The caller — the worker's finalize() — knows whether this was a
      // user Stop Generation click or the job's own overall timeout, and
      // overrides status/errorCategory accordingly; CANCELLED/USER_CANCELLED
      // here is just this layer's best default label.)
      return { status: 'CANCELLED', aiAvailable: false, error: 'Generation cancelled by user.', errorCategory: 'USER_CANCELLED' };
    }

    const blockReason = detectBlockingSensitiveContent(evidence);
    if (blockReason) {
      return {
        status: 'BLOCKED_PRIVACY',
        aiAvailable: false,
        error: `This selection contains ${blockReason}, which cannot be safely reproduced from a screenshot. Select an area without payment or password fields and try again.`,
      };
    }

    const safe = sanitizeComponentEvidence(evidence);
    // Only used by generate_component below — screenshot_to_code gets its
    // own separately token-budgeted element/ancestors from
    // buildVisionEvidence (generate_component never sends ancestors at all).
    const trimmedElement = trimNode(safe.element);
    const trimmedHtml = safe.html.length > MAX_HTML_CHARS ? `${safe.html.slice(0, MAX_HTML_CHARS)}…` : safe.html;

    // Separate, additionally token-budgeted evidence for screenshot_to_code
    // only — generate_component above (trimmedElement/trimmedHtml) is
    // unaffected. See buildVisionEvidence's doc comment for why this exists.
    const visionEvidence = buildVisionEvidence(safe, target);

    const visionResponse = await callGateway('screenshot_to_code', {
      imageBase64: safe.screenshotBase64,
      sourceUrl,
      pageTitle: safe.pageTitle,
      element: visionEvidence.element,
      ancestors: visionEvidence.ancestors,
      cssVariables: visionEvidence.cssVariables,
      assets: visionEvidence.assets,
      boundingBox: safe.boundingBox,
    }, signal);

    if (!visionResponse.success) {
      if (signal?.aborted) {
        return { status: 'CANCELLED', aiAvailable: false, error: 'Generation cancelled by user.', errorCategory: 'USER_CANCELLED' };
      }
      return {
        status: statusForFailure(visionResponse.errorCategory),
        aiAvailable: false,
        error: visionResponse.error ?? 'Code generation is temporarily unavailable.',
        errorCategory: visionResponse.errorCategory ?? 'AI_UNAVAILABLE',
      };
    }
    const visionUsedAi = visionResponse.model !== 'deterministic-fallback';

    const codeResponse = await callGateway('generate_component', {
      target,
      targetMeta: CODE_TARGET_META[target],
      uiRepresentation: visionResponse.result,
      html: trimmedHtml,
      element: trimmedElement,
      cssVariables: safe.cssVariables,
      assets: safe.assets.slice(0, 20),
    }, signal);

    if (!codeResponse.success) {
      if (signal?.aborted) {
        return { status: 'CANCELLED', aiAvailable: visionUsedAi, error: 'Generation cancelled by user.', errorCategory: 'USER_CANCELLED' };
      }
      return {
        status: statusForFailure(codeResponse.errorCategory),
        aiAvailable: visionUsedAi,
        error: codeResponse.error ?? 'Code generation is temporarily unavailable.',
        errorCategory: codeResponse.errorCategory ?? 'AI_UNAVAILABLE',
      };
    }
    const codeUsedAi = codeResponse.model !== 'deterministic-fallback';

    // Resolved before parsing files (rather than after, as previously) so
    // the HTML_CSS direct-shape fallback in parseFiles() can build sensible
    // filenames from the same name the rest of the result uses — not a
    // separate, possibly-inconsistent name.
    const aiName = codeResponse.result?.componentName as string | undefined;
    const visionName = (visionResponse.result?.suggestedComponentName as string | undefined) ?? undefined;
    const componentName = isUsableName(aiName)
      ? aiName.trim()
      : isUsableName(visionName)
        ? visionName.trim()
        : nameFromNode(evidence.element);

    const files = parseFiles(codeResponse.result, target, componentName).map((f) => ({ ...f, content: scrubString(f.content) }));
    const dependencies = Array.isArray(codeResponse.result?.dependencies)
      ? (codeResponse.result!.dependencies as unknown[]).map(String)
      : [];
    const notes = Array.isArray(codeResponse.result?.notes) ? (codeResponse.result!.notes as unknown[]).map(String) : [];

    if (files.length === 0) {
      return {
        status: 'FAILED',
        aiAvailable: visionUsedAi || codeUsedAi,
        error: 'The AI response did not contain usable component files. Try again or select a smaller area.',
        errorCategory: 'MODEL_ERROR',
      };
    }

    const result: GeneratedComponentResult = { target, componentName, files, dependencies, notes };
    const verification = verifyGeneratedComponent(target, componentName, files);

    return {
      status: 'COMPLETED',
      componentName,
      result,
      verification,
      aiAvailable: visionUsedAi || codeUsedAi,
    };
  }
}
