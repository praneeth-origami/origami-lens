import type { AiGatewayRequest, AiGatewayResponse, AiTask, CodeTarget, GenerationErrorCategory, Issue } from '@origami/contracts';

/** Thrown by callVllm on a non-2xx model-server response; carries the HTTP status for structured logging. */
export class AiRequestError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'AiRequestError';
  }
}

/**
 * Thrown by callVllm when the model server responded successfully (HTTP 2xx)
 * but its content could not be parsed as the expected JSON — e.g. wrapped in
 * markdown fences, or truncated by max_tokens before the JSON closed. This is
 * a materially different failure than the model/gateway being unreachable
 * and must not be reported to the user as "temporarily unavailable" — the AI
 * worked, the response just couldn't be consumed.
 */
export class AiResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiResponseParseError';
  }
}

/**
 * Thrown by callVllm when the model call itself was aborted by
 * AbortSignal.timeout() — a materially different failure than a connection
 * error or an HTTP error response: the model server was reachable, a request
 * was accepted, and it simply didn't finish in time. Distinguishing this
 * lets execute() report "timed out" (or, when the model is known to be too
 * large for the configured GPU budget, a resource-specific message) instead
 * of the generic "temporarily unavailable" — which wrongly implies the AI
 * infrastructure itself is down.
 */
export class AiTimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'AiTimeoutError';
  }
}

/**
 * Thrown by callVllm when the *caller* went away (the /gateway route's
 * inbound connection closed, or a job's own cancellation signal fired) —
 * distinct from AiTimeoutError, whose clock is entirely internal to this
 * service. This is what real end-to-end cancellation propagation reports:
 * empirically verified (see the project's cancellation diagnosis) that
 * aborting this fetch does cause Ollama to stop generating and release the
 * GPU within roughly one second — Ollama honors a genuinely closed
 * connection, it just was never being closed for this reason before.
 */
export class AiAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiAbortedError';
  }
}

interface AiUnavailableLogEvent {
  event: 'ai_unavailable' | 'ai_response_parse_failed' | 'ai_timeout' | 'ai_request_aborted';
  task: AiTask;
  provider: string;
  model: string;
  reason: string;
  statusCode?: number;
}

/**
 * Structured, non-sensitive diagnostic log for why a task fell back to the
 * deterministic/honest-failure path. Never includes the request payload
 * (screenshots, DOM/page content, issue text) — only task/model/provider
 * identifiers and the model server's own error text (capped, see callVllm).
 */
function logAiUnavailable(evt: AiUnavailableLogEvent): void {
  console.error(JSON.stringify(evt));
}

/**
 * A misconfigured timeout (zero, negative, NaN, or absurdly small) would
 * fire before a single model round trip could complete — worse than no
 * override at all. Falls back to the safe per-provider default and logs
 * why, instead of crashing or silently running with a nonsensical value.
 */
/** Only zero/negative/non-finite is rejected as unsafe — a deliberately small positive value (e.g. in tests) is a legitimate, if unusual, configuration, not an error. */
const MIN_MODEL_TIMEOUT_MS = 1;

/**
 * generate_component's own timeout budget, independent of AI_MODEL_TIMEOUT_MS
 * (which continues to govern screenshot_to_code and every other task).
 *
 * Derived from real, measured production data (jobId f232e4a9-c1df-44ae-be63-
 * b810a466aa9c), not guessed:
 *   - generation speed:        ~26.7 tokens/sec, steady and healthy (confirmed
 *                               via llama-server's own print_timing log, not
 *                               throttled or stuck)
 *   - output cap:               MAX_TOKENS_BY_TASK.generate_component = 4096
 *   - worst-case generation:    4096 / 26.7 ~= 153s to reach the full output cap
 *   - model reload overhead:    ~7.6s measured (this GPU can't hold both the
 *                               vision and code models at once, so Ollama
 *                               evicts/reloads between the two calls every time)
 *   - prompt evaluation:        ~2-3s for a multi-thousand-token prompt at this
 *                               model's measured ~1200 tokens/sec eval speed
 *   - safety margin:            ~15s for real-world variance (GPU contention,
 *                               a slightly larger prompt, etc.)
 * 153 + 8 + 3 + 15 ~= 179s, rounded to a clean 180s. This comfortably covers
 * even a full-length (4096-token) generation at the model's measured real
 * speed, while remaining a bounded ceiling, not an unbounded wait.
 */
const DEFAULT_CODE_GENERATION_TIMEOUT_MS = 180_000;

function validatedTimeoutMs(envValue: string | undefined, defaultMs: number, minMs: number, label: string): number {
  if (envValue === undefined || envValue === '') return defaultMs;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < minMs) {
    console.error(JSON.stringify({ event: 'invalid_timeout_config', label, providedValue: envValue, minMs, fallbackMs: defaultMs }));
    return defaultMs;
  }
  return parsed;
}

function validatedNumCtx(envValue: string | undefined, defaultCtx: number, minCtx: number, label: string): number {
  if (envValue === undefined || envValue === '') return defaultCtx;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < minCtx) {
    console.error(JSON.stringify({ event: 'invalid_num_ctx_config', label, providedValue: envValue, minCtx, fallbackCtx: defaultCtx }));
    return defaultCtx;
  }
  return parsed;
}

/**
 * Ollama serves each model with a fixed context window (default observed:
 * 4096 tokens) unless a caller overrides it per-request via `options.num_ctx`
 * on the chat-completions body. screenshot_to_code/generate_component prompts
 * routinely exceed 4096 once the image + DOM/HTML representation is included
 * (a real request measured at 4765 tokens was rejected outright with a 400
 * "exceed_context_size_error" — not a timeout, not a network issue, just the
 * window being too small), so every Ollama call requests a larger window.
 * Configurable via AI_OLLAMA_NUM_CTX for environments with different model
 * sizes/VRAM budgets; the floor matches Ollama's own common default so a
 * misconfigured value can never make the window smaller than before.
 */
const OLLAMA_NUM_CTX = validatedNumCtx(process.env.AI_OLLAMA_NUM_CTX, 8192, 4096, 'AI_OLLAMA_NUM_CTX');

/**
 * Ollama's native /api/chat expects `message.content` to be a plain string,
 * with any image(s) in a separate `images: string[]` array of bare base64
 * (no `data:image/...;base64,` prefix) — sending it the OpenAI-style
 * multimodal content array (`content: [{type:'text',...},{type:'image_url',
 * image_url:{url:'data:...'}}]`, built by buildUserMessage for the OpenAI-
 * compatible path shared with vLLM) fails outright with "json: cannot
 * unmarshal array into Go struct field ChatRequest.messages.content of type
 * string" — confirmed empirically, not a hypothetical. This is a real
 * request-shape divergence between the two APIs, not just the `options`
 * field difference that motivated switching to the native endpoint in the
 * first place.
 */
function toOllamaMessage(
  message: { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> },
): { role: 'user'; content: string; images?: string[] } {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content };
  }
  const text = message.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
  const images = message.content
    .filter((p) => p.type === 'image_url' && p.image_url?.url)
    .map((p) => (p.image_url!.url.includes(',') ? p.image_url!.url.split(',')[1] : p.image_url!.url));
  return images.length > 0 ? { role: 'user', content: text, images } : { role: 'user', content: text };
}

/**
 * Models routinely wrap structured JSON output in markdown code fences
 * (```json ... ```) even under a provider "JSON mode" request parameter —
 * that constrains valid-JSON-ness of the fenced content, not whether the
 * model wraps it. Strips a wrapping fence, then falls back to slicing
 * between the first "{" and last "}" for stray leading/trailing prose.
 */
function extractJsonPayload(raw: string): string {
  let text = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return text;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

/**
 * generate_component/fix_code return multi-file source and screenshot_to_code
 * returns a fairly verbose UI description — a flat 1024-token cap silently
 * truncated these mid-string, producing invalid JSON that got misreported as
 * the model being unavailable. Other tasks return a small fixed-shape object
 * where 1024 is already generous.
 */
const MAX_TOKENS_BY_TASK: Partial<Record<AiTask, number>> = {
  generate_component: 4096,
  fix_code: 4096,
  screenshot_to_code: 2048,
};
const DEFAULT_MAX_TOKENS = 1024;

/** Default text model — override via AI_TEXT_MODEL (e.g. Ollama: qwen2.5:7b). */
export const DEFAULT_TEXT_MODEL = process.env.AI_TEXT_MODEL ?? 'qwen2.5:7b';

/** Task → model routing. Application code never references model names directly. */
export const TASK_MODEL_MAP: Record<AiTask, string> = {
  summarize_scan: DEFAULT_TEXT_MODEL,
  explain_issue: DEFAULT_TEXT_MODEL,
  ask: DEFAULT_TEXT_MODEL,
  fix_code: DEFAULT_TEXT_MODEL,
  visual_qa: process.env.AI_VISION_MODEL ?? 'Qwen3-VL-8B-Instruct',
  ocr: process.env.AI_OCR_MODEL ?? 'PaddleOCR-VL-1.6',
  repository_search: process.env.AI_EMBED_MODEL ?? 'BGE-M3',
  // Screenshot -> Code: vision analysis reuses the same vision model as visual_qa.
  screenshot_to_code: process.env.AI_VISION_MODEL ?? 'Qwen3-VL-8B-Instruct',
  generate_component: process.env.AI_CODE_MODEL ?? 'Qwen3-Coder-Next',
};

export interface VllmConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface RequiredModelStatus {
  task: AiTask;
  model: string;
  /** The model name is registered with the model server. */
  available: boolean;
  /**
   * Best-effort check of whether the model's on-disk size fits the configured
   * GPU budget (AI_GPU_VRAM_MB). `undefined` when this can't be determined —
   * no budget configured, provider isn't Ollama, or the size lookup failed —
   * in which case it is never treated as a reason to consider the model
   * not-ready (see `ready` below).
   */
  fitsBudget?: boolean;
  /**
   * Real capability signal: registered AND not known to be too large for the
   * configured hardware. This is what readiness/generation-capability checks
   * should use — `available` alone only proves the name exists on the
   * server, not that a real generation call can complete on this hardware
   * (this is exactly the aiAvailable=true-but-generation-fails gap).
   */
  ready: boolean;
}

export interface ModelAvailabilityReport {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  reachable: boolean;
  availableModels: string[];
  requiredModels: RequiredModelStatus[];
  error?: string;
}

export class OrigamiAiGateway {
  constructor(private config: VllmConfig) {}

  getModelForTask(task: AiTask): string {
    return TASK_MODEL_MAP[task];
  }

  private requiredModelsList(): Array<{ task: AiTask; model: string }> {
    // Every task is reported individually, even where two tasks currently
    // share a model (e.g. visual_qa and screenshot_to_code both default to
    // the vision model) — deduping by model would silently drop one of them
    // from the report even though each is a distinct capability callers rely on.
    const tasks: AiTask[] = [
      'summarize_scan', 'explain_issue', 'ask', 'fix_code',
      'visual_qa', 'screenshot_to_code', 'generate_component',
    ];
    return tasks.map((task) => ({ task, model: TASK_MODEL_MAP[task] }));
  }

  /**
   * Real capability check: does the configured model server actually have the
   * models each task needs, not just "is the process up". Both vLLM and
   * Ollama's OpenAI-compat layer expose GET {baseUrl}/models.
   */
  async checkModelAvailability(): Promise<ModelAvailabilityReport> {
    const provider = this.provider();
    const required = this.requiredModelsList();

    if (!this.config.enabled) {
      return {
        enabled: false,
        provider,
        baseUrl: this.config.baseUrl,
        reachable: false,
        availableModels: [],
        requiredModels: required.map((r) => ({ ...r, available: false, ready: false })),
      };
    }

    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          enabled: true,
          provider,
          baseUrl: this.config.baseUrl,
          reachable: false,
          availableModels: [],
          requiredModels: required.map((r) => ({ ...r, available: false, ready: false })),
          error: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as { data?: Array<{ id: string }> };
      const availableModels = (data.data ?? []).map((m) => m.id);
      // One lookup for the whole report, not one per required model — this is
      // the "lightweight" part: a single fast metadata call, never inference.
      const sizeByModel = await this.modelSizesByName();
      const budgetBytes = this.gpuBudgetBytes();

      return {
        enabled: true,
        provider,
        baseUrl: this.config.baseUrl,
        reachable: true,
        availableModels,
        requiredModels: required.map((r) => {
          const available = availableModels.includes(r.model);
          const fitsBudget = this.fitsBudget(sizeByModel.get(r.model), budgetBytes);
          return { ...r, available, fitsBudget, ready: available && fitsBudget !== false };
        }),
      };
    } catch (error) {
      return {
        enabled: true,
        provider,
        baseUrl: this.config.baseUrl,
        reachable: false,
        availableModels: [],
        requiredModels: required.map((r) => ({ ...r, available: false, ready: false })),
        error: error instanceof Error ? error.message : 'Model server unreachable',
      };
    }
  }

  private provider(): string {
    return this.config.baseUrl.includes(':11434') ? 'ollama' : 'vllm';
  }

  /**
   * Fraction of the configured GPU budget a model's on-disk weight size may
   * use before it's flagged as resource-constrained. Deliberately calibrated
   * against real observed behavior on this project's dev hardware (a 6144MB
   * GPU), not an arbitrary margin: qwen3-vl:8b-instruct (~6.1GB, ~95% of that
   * budget) completed every real Screenshot -> Code generation it was asked
   * to do — Ollama's CPU-offload absorbs the small overage — while
   * qwen3-coder:30b (~18GB, ~288% of that budget) is what was actually timing
   * out. A factor near 1.0 separates that known-good case from the
   * known-bad one; a stricter margin (e.g. leaving headroom for KV
   * cache/context) would incorrectly flag the vision model as constrained
   * despite its demonstrated reliability. Adjust upward only with fresh
   * evidence that a model at this ratio is actually failing.
   */
  private static readonly RESOURCE_SAFETY_FACTOR = 1.0;

  private gpuBudgetBytes(): number | undefined {
    const mb = Number(process.env.AI_GPU_VRAM_MB);
    return mb > 0 ? mb * 1024 * 1024 : undefined;
  }

  private fitsBudget(sizeBytes: number | undefined, budgetBytes: number | undefined): boolean | undefined {
    // Unknown unless both the model's size and a configured budget are
    // available — absence of information must never read as "doesn't fit".
    if (sizeBytes === undefined || budgetBytes === undefined) return undefined;
    return sizeBytes <= budgetBytes * OrigamiAiGateway.RESOURCE_SAFETY_FACTOR;
  }

  /**
   * The OpenAI-compatible {baseUrl}/models endpoint used above doesn't report
   * model size. Ollama's own /api/tags does — this is a single fast metadata
   * GET (never inference) against the native API root, derived by stripping
   * the "/v1" the OpenAI-compat layer is mounted under. Deliberately not
   * gated on providerbrand: it's cheap, and a server that doesn't implement
   * this path (a real vLLM deployment, for instance) just 404s or refuses
   * the connection, handled below the same as any other "unknown" case.
   * Returns an empty map (never throws) when unreachable/unsupported, so
   * callers always fall back to "unknown fit" rather than a hard failure.
   */
  private async modelSizesByName(): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const nativeBase = this.config.baseUrl.replace(/\/v1\/?$/, '');
    try {
      const response = await fetch(`${nativeBase}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return sizes;
      const data = (await response.json()) as { models?: Array<{ name: string; size?: number }> };
      for (const m of data.models ?? []) {
        if (typeof m.size === 'number') sizes.set(m.name, m.size);
      }
    } catch {
      // Best-effort only — an unreachable /api/tags just means "unknown fit".
    }
    return sizes;
  }

  /**
   * Used on the rare timeout path (see execute()) to decide whether a
   * generate_component/screenshot_to_code timeout should be reported as a
   * plain timeout or as a resource/configuration issue. Only meaningful when
   * AI_GPU_VRAM_MB is configured; otherwise always "unknown" (never blames
   * resources without evidence).
   */
  private async isResourceConstrained(model: string): Promise<boolean> {
    const budgetBytes = this.gpuBudgetBytes();
    if (budgetBytes === undefined) return false;
    const sizes = await this.modelSizesByName();
    const fits = this.fitsBudget(sizes.get(model), budgetBytes);
    return fits === false;
  }

  /**
   * `externalSignal`, when provided by the /gateway route, is tied to the
   * inbound HTTP connection's real lifetime (aborted the moment the caller
   * genuinely disconnects — see index.ts) — combined with this call's own
   * internal AI_MODEL_TIMEOUT_MS budget so either one can end the downstream
   * Ollama request. Confirmed empirically (not assumed) that aborting the
   * fetch to Ollama actually stops its GPU-side generation within ~1s; the
   * previous "orphaned generation" bug was never Ollama ignoring an abort —
   * it was that nothing ever sent it one when the caller went away.
   */
  async execute(request: AiGatewayRequest, externalSignal?: AbortSignal): Promise<AiGatewayResponse> {
    const model = this.getModelForTask(request.task);
    const sanitized = request.payload;

    if (!this.config.enabled) {
      logAiUnavailable({
        event: 'ai_unavailable',
        task: request.task,
        provider: 'none',
        model,
        reason: 'AI_ENABLED is false',
      });
      return { ...this.fallbackResponse(request.task, sanitized), errorCategory: 'AI_UNAVAILABLE' };
    }

    try {
      const result = await this.callVllm(model, request.task, sanitized, externalSignal);
      return { success: true, task: request.task, model, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI request failed';
      const statusCode = error instanceof AiRequestError ? error.statusCode : undefined;
      const isParseFailure = error instanceof AiResponseParseError;
      const isTimeout = error instanceof AiTimeoutError;
      const isAborted = error instanceof AiAbortedError;

      logAiUnavailable({
        event: isParseFailure ? 'ai_response_parse_failed' : isTimeout ? 'ai_timeout' : isAborted ? 'ai_request_aborted' : 'ai_unavailable',
        task: request.task,
        provider: this.provider(),
        model,
        reason: message,
        statusCode,
      });

      // The caller (its own timeout, or a user's Stop Generation click)
      // went away — this call was cancelled, not failed. No fallback
      // response is meaningful here since nothing is waiting to read it,
      // but returning a well-formed, correctly-categorized response keeps
      // this method's contract simple for any caller that does still care.
      if (isAborted) {
        return {
          success: false,
          task: request.task,
          model: 'deterministic-fallback',
          error: 'Generation cancelled.',
          errorCategory: 'CLIENT_DISCONNECTED',
        };
      }

      // A parse failure means the model DID respond — this is a different
      // failure than the model/gateway being unreachable and must say so,
      // not reuse the "temporarily unavailable" message (that would blame
      // the wrong layer and mislead anyone debugging it, including a future
      // reader of this code).
      if (isParseFailure) {
        return {
          success: false,
          task: request.task,
          model: 'deterministic-fallback',
          error: 'The AI generated a response that could not be processed. Please try again.',
          errorCategory: 'MODEL_ERROR',
        };
      }

      // A timeout on screenshot_to_code/generate_component means the model
      // server WAS reachable and DID accept the request — a different, more
      // specific failure than "temporarily unavailable" (which implies the
      // infrastructure itself is down). When the model is known to be too
      // large for the configured GPU budget, say so precisely instead of
      // implying a transient blip that a plain retry will fix.
      if (isTimeout && (request.task === 'screenshot_to_code' || request.task === 'generate_component')) {
        const resourceConstrained = await this.isResourceConstrained(model);
        return {
          success: false,
          task: request.task,
          model: 'deterministic-fallback',
          error: resourceConstrained
            ? 'Code generation could not be completed with the current AI configuration.'
            : 'Code generation timed out. Please try again.',
          errorCategory: 'MODEL_TIMEOUT',
        };
      }

      const fallback = this.fallbackResponse(request.task, sanitized);
      // Preserve a task's own user-facing fallback message (e.g. "Code generation is
      // temporarily unavailable.") instead of leaking the raw connection/HTTP error.
      // The real reason is still captured above via logAiUnavailable for operators.
      // isTimeout checked first: a timeout must always classify as
      // MODEL_TIMEOUT regardless of task — the screenshot_to_code/
      // generate_component branch above only exists to pick a more specific
      // *message*, not to gate the category itself.
      const errorCategory: GenerationErrorCategory = isTimeout
        ? 'MODEL_TIMEOUT'
        : statusCode === 413
          ? 'PAYLOAD_TOO_LARGE'
          : statusCode
            ? 'MODEL_ERROR'
            : 'NETWORK_ERROR';
      return { ...fallback, error: fallback.error ?? message, errorCategory };
    }
  }

  /**
   * `externalSignal`, when provided, is combined with this call's own
   * internal AI_MODEL_TIMEOUT_MS budget via AbortSignal.any — either one
   * aborts the SAME outbound fetch to Ollama. This is the actual fix for the
   * previously-diagnosed "orphaned generation" bug: before, only the
   * internal timeout could ever abort this fetch, so a caller disconnecting
   * (Stop Generation, or its own outer timeout) had no way to reach this
   * far down. Empirically confirmed (see the project's cancellation
   * diagnosis) that aborting this exact fetch does release Ollama's GPU
   * usage within roughly one second — this was never an Ollama limitation.
   */
  private async callVllm(
    model: string,
    task: AiTask,
    payload: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const systemPrompt = this.buildSystemPrompt(task, payload);
    const userMessage = this.buildUserMessage(task, payload);

    const isOllama = this.provider() === 'ollama';
    // Configurable via AI_MODEL_TIMEOUT_MS so a development environment
    // running a right-sized model (fast) and a production environment
    // running a much larger model on real GPU infrastructure (slower to
    // load, more tokens to generate) can each set a realistic budget without
    // touching code. 140s/45s are the historical per-provider defaults, kept
    // for anyone who hasn't set the env var. This must stay LESS than
    // component-generator.ts's own GATEWAY_CALL_TIMEOUT_MS (AI_GATEWAY_TIMEOUT_MS) —
    // an outer timeout tighter than the inner one it wraps just wastes the
    // model's work and reports the wrong failure.
    //
    // generate_component gets its OWN, larger budget (AI_CODE_GENERATION_TIMEOUT_MS)
    // rather than sharing AI_MODEL_TIMEOUT_MS with screenshot_to_code — a real
    // production job (jobId f232e4a9...) measured this exact model generating
    // at a steady ~26.7 tokens/sec, healthy and not stuck, but still cancelled
    // at the shared 60s ceiling after producing >=1299 of its up-to-4096-token
    // output budget (MAX_TOKENS_BY_TASK.generate_component below). Vision and
    // code generation are different workloads (vision: fixed-size structured
    // description; code: can legitimately need close to the full output cap
    // for a complex component) and sharing one timeout under-serves whichever
    // one needs more room. AI_MODEL_TIMEOUT_MS's own behavior for
    // screenshot_to_code (and every other task) is completely unchanged.
    const timeoutMs = task === 'generate_component'
      ? validatedTimeoutMs(process.env.AI_CODE_GENERATION_TIMEOUT_MS, DEFAULT_CODE_GENERATION_TIMEOUT_MS, MIN_MODEL_TIMEOUT_MS, 'AI_CODE_GENERATION_TIMEOUT_MS')
      : validatedTimeoutMs(process.env.AI_MODEL_TIMEOUT_MS, isOllama ? 140_000 : 45_000, MIN_MODEL_TIMEOUT_MS, 'AI_MODEL_TIMEOUT_MS');
    const maxTokens = MAX_TOKENS_BY_TASK[task] ?? DEFAULT_MAX_TOKENS;

    // Ollama's OpenAI-compatible /v1/chat/completions endpoint silently
    // DROPS an `options` field (confirmed empirically: /api/ps kept reporting
    // context_length: 4096 after sending options.num_ctx there, even on a
    // guaranteed-cold model load) — only its own native /api/chat endpoint
    // actually resizes the loaded context. Ollama's native API also expects
    // generation parameters (temperature, the output-length cap) nested
    // under `options` rather than top-level, so the two request shapes
    // genuinely diverge, not just this one field.
    let requestBody: Record<string, unknown>;
    if (isOllama) {
      requestBody = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          toOllamaMessage(userMessage),
        ],
        format: 'json',
        stream: false,
        options: {
          temperature: 0.3,
          // generate_component/fix_code return multi-file source and
          // screenshot_to_code returns a fairly verbose UI description — the
          // previous flat 1024-token budget silently truncated these into
          // invalid JSON (observed as "Unterminated string in JSON..."),
          // which then got misreported as the model being unavailable.
          num_predict: maxTokens,
          num_ctx: OLLAMA_NUM_CTX,
        },
      };
    } else {
      requestBody = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          userMessage,
        ],
        temperature: 0.3,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: 'json_object' },
      };
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

    // Ollama's OpenAI-compat base URL is configured as .../v1 — its native
    // API lives one level up, at .../api/chat, not .../v1/chat/completions.
    const url = isOllama
      ? `${this.config.baseUrl.replace(/\/?v1\/?$/, '')}/api/chat`
      : `${this.config.baseUrl}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new AiTimeoutError(`Model call timed out after ${timeoutMs}ms`, timeoutMs);
      }
      // Distinguish "our own budget ran out" (timeoutSignal, handled above)
      // from "the caller went away" (externalSignal) — both produce a plain
      // AbortError from fetch, so the only way to tell them apart is which
      // underlying signal is actually the one that fired.
      if (externalSignal?.aborted && !timeoutSignal.aborted) {
        throw new AiAbortedError('Caller disconnected before the model responded');
      }
      throw error;
    }

    if (!response.ok) {
      // Cap the model server's own error text — some servers echo part of the
      // request back in validation errors, and this can end up in logs.
      const rawDetail = await response.text().catch(() => '');
      const detail = rawDetail.length > 300 ? `${rawDetail.slice(0, 300)}…` : rawDetail;
      throw new AiRequestError(
        `AI error: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
        response.status,
      );
    }

    // Native Ollama responses are shaped { message: { content } }; the
    // OpenAI-compatible shape (vLLM, and any other OpenAI-compatible
    // provider) is { choices: [{ message: { content } }] }.
    const content = isOllama
      ? ((await response.json()) as { message?: { content?: string } }).message?.content ?? '{}'
      : ((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message?.content ?? '{}';
    try {
      return JSON.parse(extractJsonPayload(content)) as Record<string, unknown>;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Invalid JSON';
      // Never include `content` itself here — it's the model's generated
      // output, not the input page/screenshot, but still not something to
      // put in an infrastructure log by default.
      throw new AiResponseParseError(`Model response was not valid JSON (length=${content.length}): ${reason}`);
    }
  }

  private buildUserMessage(
    task: AiTask,
    payload: Record<string, unknown>,
  ): { role: 'user'; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> } {
    if ((task === 'visual_qa' || task === 'screenshot_to_code') && typeof payload.imageBase64 === 'string') {
      const { imageBase64, ...rest } = payload;
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(rest, null, 2),
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      };
    }

    return {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    };
  }

  /**
   * `payload` is only consulted for `generate_component`, to pick a
   * target-specific example (see below) — every other task's prompt is
   * unaffected and identical to before.
   */
  private buildSystemPrompt(task: AiTask, payload?: Record<string, unknown>): string {
    const base = 'You are Origami Lens AI. Respond ONLY with valid JSON. Do not invent issues. Explain deterministic evidence. Use "likely cause" when root cause is unproven.';

    switch (task) {
      case 'explain_issue':
        return `${base} Return: {"problem":"","cause":"","impact":"","suggestedFix":"","confidence":0.0}`;
      case 'summarize_scan':
        return `${base} Return: {"summary":"","topIssues":[],"recommendations":[]}`;
      case 'visual_qa':
        return `${base} Return: {"findings":[],"problem":"","cause":"","impact":"","suggestedFix":""}`;
      case 'fix_code':
        return `${base} Return: {"fix":"","explanation":"","files":[]}`;
      case 'ask':
        return `${base} Return: {"answer":"","confidence":0.0}`;
      case 'ocr':
        return `${base} Return: {"text":"","regions":[]}`;
      case 'repository_search':
        return `${base} Return: {"chunks":[],"scores":[]}`;
      case 'screenshot_to_code':
        return `${base} You are analyzing a cropped screenshot of one UI region plus its DOM/CSS context. Describe its visual structure so a coding model can rebuild it. Do not describe the whole page, only the selected region. Replace any real personal names, emails, phone numbers, or account data visible in the screenshot with generic placeholders (e.g. "User Name", "user@example.com") in your description — never repeat real personal data verbatim. Return: {"suggestedComponentName":"PascalCaseName","summary":"","sections":[{"role":"","description":""}],"colors":[],"typography":{"headingFont":"","bodyFont":""},"layout":""}`;
      case 'generate_component': {
        // Root cause of "always generates HTML regardless of selected
        // target": this prompt used to be near-identical for all four
        // targets — REACT/NEXT_JS/TAILWIND shared one generic ".jsx"
        // example and a single vague "follow targetMeta.primaryExtension"
        // instruction, with the actual framework/styling conventions left
        // entirely to the model to infer. A general-purpose local model
        // given that little guidance reliably falls back to the output
        // shape it's most confident about — plain HTML/CSS — regardless of
        // what target was actually requested. Each target now gets its own
        // explicit instructions AND its own worked example, so the prompt
        // itself (not just the payload's target/targetMeta fields, which
        // the model was never reliably reading) drives the output shape.
        const target = (payload?.target as CodeTarget | undefined) ?? 'HTML_CSS';
        const targetMeta = payload?.targetMeta as { label?: string } | undefined;
        const targetLabel = targetMeta?.label ?? target;

        const TARGET_SPEC: Record<CodeTarget, { instructions: string; example: string }> = {
          HTML_CSS: {
            instructions: 'Produce plain, framework-free HTML and CSS: one ".html" file with semantic markup, and one companion ".css" file whose selectors match the classes used in the HTML. Do not use any JavaScript framework, JSX, or build tooling.',
            example: '{"componentName":"ExampleComponent","files":[{"path":"example.html","content":"<div class=\\"example\\">...</div>"},{"path":"example.css","content":".example { ... }"}],"dependencies":[],"notes":[]}',
          },
          REACT: {
            instructions: 'Produce a single React functional component in one ".jsx" file (never ".html") using JSX syntax, ending with `export default function ComponentName(...) { ... }`. Style it with CSS Modules: create a companion "ComponentName.module.css" file, import it with `import styles from \'./ComponentName.module.css\'`, and apply classes via `className={styles.foo}` — never a top-level "html"/"css" field, never a <style> tag.',
            example: '{"componentName":"PricingCard","files":[{"path":"PricingCard.jsx","content":"import styles from \'./PricingCard.module.css\';\\n\\nexport default function PricingCard() {\\n  return <div className={styles.card}>...</div>;\\n}"},{"path":"PricingCard.module.css","content":".card { ... }"}],"dependencies":[],"notes":[]}',
          },
          NEXT_JS: {
            instructions: 'Produce a single Next.js-compatible React component in one ".jsx" file (never ".html"), using JSX syntax and `export default function ComponentName(...) { ... }`, compatible with the Next.js App Router. Add a `\'use client\';` directive as the very first line ONLY if the component uses state, effects, or browser event handlers (onClick, onChange, etc.) — omit it for a purely presentational component, since Next.js Server Components cannot use those. Style it with CSS Modules exactly like a React component: a companion "ComponentName.module.css" file, imported and applied via `className={styles.foo}`.',
            example: '{"componentName":"PricingCard","files":[{"path":"PricingCard.jsx","content":"\'use client\';\\n\\nimport { useState } from \'react\';\\nimport styles from \'./PricingCard.module.css\';\\n\\nexport default function PricingCard() {\\n  const [selected, setSelected] = useState(false);\\n  return <div className={styles.card}>...</div>;\\n}"},{"path":"PricingCard.module.css","content":".card { ... }"}],"dependencies":[],"notes":[]}',
          },
          TAILWIND: {
            instructions: 'Produce a single React functional component in one ".jsx" file (never ".html"), using JSX syntax and `export default function ComponentName(...) { ... }`. Style it ENTIRELY with Tailwind CSS utility classes applied directly in `className` (spacing, color, typography, borders, shadows, flex/grid layout, and responsive variants like `sm:`/`md:`/`lg:` where the original layout is responsive) — do NOT create a separate .css file, do NOT use CSS Modules, do NOT use a <style> tag or inline `style={{}}` for anything Tailwind can express. Only include a "files" entry for the .jsx component itself.',
            example: '{"componentName":"PricingCard","files":[{"path":"PricingCard.jsx","content":"export default function PricingCard() {\\n  return <div className=\\"rounded-lg shadow-md p-6 bg-white\\">...</div>;\\n}"}],"dependencies":[],"notes":[]}',
          },
        };
        const spec = TARGET_SPEC[target] ?? TARGET_SPEC.HTML_CSS;

        return `${base} You generate a single reusable frontend component from a structured UI description plus DOM/CSS evidence, for the "${targetLabel}" target specifically — the target is fixed by the caller and must not change. Recreate structure, spacing, typography, colors, borders, radius, shadows, and responsive layout using normal Flexbox/Grid — no unnecessary absolute positioning, no unnecessary dependencies, no fake APIs, no secrets. Use only generic placeholder text/data (never reproduce real personal names, emails, phone numbers, or payment data — use "User Name", "user@example.com"-style placeholders instead). Name the component meaningfully from its purpose (e.g. PricingCard, Navbar, LoginForm) — never "Component1", "TestComponent", or "AIComponent". ${spec.instructions} Output contract, exactly: "files" MUST be a JSON array. Every entry in "files" MUST have a "path" field (the filename) and a "content" field (the complete source for that file) — these two field names are required exactly as written, not "filename", "code", "source", or any other name. Do NOT return top-level "html", "css", "jsx", "tsx", or "code" fields instead of "files" — always place every file inside the "files" array. Do not wrap the JSON in markdown code fences. Do not include any text, explanation, or markdown outside the JSON object. Return ONLY the JSON object, exactly matching this shape: ${spec.example}`;
      }
      default:
        return base;
    }
  }

  private fallbackResponse(task: AiTask, payload: Record<string, unknown>): AiGatewayResponse {
    const issue = payload.issue as Issue | undefined;

    if (task === 'explain_issue' && issue) {
      return {
        success: true,
        task,
        model: 'deterministic-fallback',
        result: {
          problem: issue.problem || issue.title,
          cause: issue.cause || 'Deterministic rule detected this from browser evidence.',
          impact: issue.impact,
          suggestedFix: issue.suggestedFix,
          confidence: issue.confidence,
        },
      };
    }

    if (task === 'ask') {
      return {
        success: true,
        task,
        model: 'deterministic-fallback',
        result: {
          answer: 'AI explanation unavailable. Review the deterministic scan findings and evidence above.',
          confidence: 0.5,
        },
      };
    }

    if (task === 'summarize_scan') {
      const issues = (payload.issues as Issue[]) ?? [];
      return {
        success: true,
        task,
        model: 'deterministic-fallback',
        result: {
          summary: `Scan found ${issues.length} issue(s). Health score reflects deterministic analysis.`,
          topIssues: issues.slice(0, 5).map((i) => i.title),
          recommendations: issues.slice(0, 3).map((i) => i.suggestedFix),
        },
      };
    }

    if (task === 'visual_qa') {
      return {
        success: true,
        task,
        model: 'deterministic-fallback',
        result: {
          findings: [],
          problem: '',
          cause: '',
          impact: '',
          suggestedFix: '',
        },
      };
    }

    if (task === 'screenshot_to_code' || task === 'generate_component') {
      // No deterministic fallback exists for whole-component generation — a fabricated
      // component would be worse than an honest failure. The caller surfaces this as
      // "Code generation is temporarily unavailable" and allows retry.
      return {
        success: false,
        task,
        model: 'deterministic-fallback',
        error: 'Code generation is temporarily unavailable.',
      };
    }

    return {
      success: false,
      task,
      model: 'deterministic-fallback',
      error: 'AI explanation unavailable.',
    };
  }
}

export class AiRouter {
  private gateway: OrigamiAiGateway;

  constructor(config?: Partial<VllmConfig>) {
    this.gateway = new OrigamiAiGateway({
      baseUrl: config?.baseUrl ?? process.env.VLLM_BASE_URL ?? 'http://localhost:8000/v1',
      apiKey: config?.apiKey ?? process.env.VLLM_API_KEY ?? 'not-needed',
      enabled: config?.enabled ?? process.env.AI_ENABLED !== 'false',
    });
  }

  shouldUseAi(task: AiTask): boolean {
    return ['explain_issue', 'visual_qa', 'ask', 'fix_code', 'summarize_scan', 'screenshot_to_code', 'generate_component'].includes(task);
  }

  async route(request: AiGatewayRequest, signal?: AbortSignal): Promise<AiGatewayResponse> {
    return this.gateway.execute(request, signal);
  }

  async checkModelAvailability(): Promise<ModelAvailabilityReport> {
    return this.gateway.checkModelAvailability();
  }
}
