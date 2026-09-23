import './load-env.js';
import Fastify from 'fastify';
import type { AiGatewayRequest, AskRequest, ExplainIssueRequest } from '@origami/contracts';
import { scrubString, sanitizeForAi } from '@origami/privacy';
import { AiRouter } from './gateway.js';
import {
  BgeM3EmbeddingProvider,
  EmbeddingCancelledError,
  EmbeddingInvalidResponseError,
  EmbeddingTimeoutError,
  EmbeddingUnavailableError,
  resolveEmbeddingConfig,
} from './embedding-provider.js';
import {
  BgeRerankerProvider,
  RerankerCancelledError,
  RerankerInvalidResponseError,
  RerankerTimeoutError,
  RerankerUnavailableError,
  resolveRerankerConfig,
} from './reranker-provider.js';
import {
  RepositoryAiCancelledError,
  RepositoryAiInvalidResponseError,
  RepositoryAiTimeoutError,
  RepositoryAiUnavailableError,
  analyzeRepositoryIssue,
  proposeRepositoryFix,
  resolveRepositoryAiConfig,
  type EvidenceChunk,
  type IssueAnalysisResult,
} from './repository-issue-ai-provider.js';
import {
  RepositoryQaCancelledError,
  RepositoryQaInvalidResponseError,
  RepositoryQaTimeoutError,
  RepositoryQaUnavailableError,
  answerRepositoryQuestion,
  resolveRepositoryQaConfig,
} from './repository-qa-provider.js';
import {
  FindingFixCancelledError,
  FindingFixInvalidResponseError,
  FindingFixTimeoutError,
  FindingFixUnavailableError,
  proposeFindingFix,
  resolveFindingFixConfig,
} from './repository-finding-fix-provider.js';

const PORT = Number(process.env.AI_ROUTER_PORT ?? 3102);
const HOST = process.env.AI_ROUTER_HOST ?? '0.0.0.0';

/**
 * Matches apps/api/src/index.ts's MAX_REQUEST_BODY_MB / rationale — POST
 * /gateway for screenshot_to_code/generate_component relays the same base64
 * screenshot + trimmed DOM evidence that route already had to accept, so
 * this route needs at least as generous a limit. Fastify's 1MB default was
 * silently rejecting these calls with a 413, which component-generator.ts's
 * callGateway() then reported as the generic "Code generation is temporarily
 * unavailable." — see that file's structured 'ai_gateway_payload_too_large'
 * log event for how this specific failure is now distinguished from a
 * genuine connectivity/availability problem.
 */
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_MB || 8) * 1024 * 1024;

const router = new AiRouter();

/**
 * Phase 4 — BGE-M3 embeddings. Deliberately its own provider instance, never
 * threaded through AiRouter/OrigamiAiGateway: embeddings are not a chat task
 * and must not share TASK_MODEL_MAP routing, timeouts, or retry behavior
 * with generate_component/screenshot_to_code/etc.
 */
const embeddingProvider = new BgeM3EmbeddingProvider(resolveEmbeddingConfig());

/**
 * Phase 5 — bge-reranker-v2-m3. Its own provider instance and its own
 * server (AI_RERANKER_BASE_URL), independent from both the chat models and
 * embeddingProvider above — a reranker is a cross-encoder, not a chat model
 * or a bi-encoder embedding model, and must never be routed through
 * /gateway or coupled to TASK_MODEL_MAP.
 */
const rerankerProvider = new BgeRerankerProvider(resolveRerankerConfig());

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES });

app.get('/health', async () => ({ status: 'ok', service: 'ai-router' }));

// Real capability check — distinct from /health, which only confirms this
// process is up. This confirms the configured model server is reachable AND
// that the specific models each AI task needs are actually deployed there.
app.get('/health/models', async () => router.checkModelAvailability());

/**
 * Phase 4 — confirms the configured BGE-M3 model is actually registered
 * with the model server, independent of /health/models (which never checks
 * embedding capability at all — repository_search is intentionally excluded
 * from OrigamiAiGateway's requiredModelsList, see gateway.ts).
 */
app.get('/health/embedding-model', async () => {
  const status = await embeddingProvider.isModelAvailable();
  return { model: embeddingProvider.model, ...status };
});

/**
 * Phase 4 — BGE-M3 embedding generation for repository code chunks. Never
 * shares a route, model routing, or timeout with /gateway's chat-completion
 * tasks. `texts` are already Phase 3 code chunks by the time they reach
 * here — this route has no knowledge of repositories/chunks/Postgres at
 * all, it only ever sees plain strings to embed (see the repository
 * embedding worker for how those strings are built).
 */
app.post<{ Body: { texts: string[] } }>('/embed', async (request, reply) => {
  const texts = request.body?.texts;
  if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => typeof t === 'string')) {
    return reply.status(400).send({ error: 'texts must be a non-empty array of strings' });
  }

  // Same privacy posture as /gateway: never send unscrubbed text to a model
  // server. scrubString (not sanitizeForAi, which is object-shaped) is the
  // right primitive here since each input is a single code+metadata string,
  // not a keyed payload object.
  const scrubbed = texts.map((t) => scrubString(t));

  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);

  try {
    const result = await embeddingProvider.embedBatch(scrubbed, controller.signal);
    return { model: result.model, dimensions: result.dimensions, vectors: result.vectors };
  } catch (error) {
    if (error instanceof EmbeddingCancelledError) {
      return reply.status(499).send({ error: error.message, errorCategory: 'EMBEDDING_CANCELLED' });
    }
    if (error instanceof EmbeddingTimeoutError) {
      return reply.status(504).send({ error: error.message, errorCategory: 'EMBEDDING_TIMEOUT' });
    }
    if (error instanceof EmbeddingInvalidResponseError) {
      return reply.status(502).send({ error: error.message, errorCategory: 'EMBEDDING_INVALID_RESPONSE' });
    }
    if (error instanceof EmbeddingUnavailableError) {
      return reply.status(503).send({ error: error.message, errorCategory: 'EMBEDDING_PROVIDER_UNAVAILABLE' });
    }
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

/**
 * Phase 5 — confirms the configured reranker server is reachable,
 * independent of /health/models and /health/embedding-model (neither of
 * which know anything about reranking).
 */
app.get('/health/reranker', async () => {
  const status = await rerankerProvider.isAvailable();
  return { model: rerankerProvider.model, ...status };
});

/**
 * Phase 5 — bge-reranker-v2-m3 candidate reranking. Never shares a route,
 * model routing, or timeout with /gateway's chat-completion tasks or
 * /embed's embedding generation. `documents` are already Phase 3 code
 * chunks formatted as plain strings by the time they reach here — this
 * route has no knowledge of repositories/chunks/Postgres at all, and the
 * reranker is never asked to explain, fix, generate, or summarize anything,
 * only to score the documents it's given against the query.
 */
app.post<{ Body: { query: string; documents: string[] } }>('/rerank', async (request, reply) => {
  const { query, documents } = request.body ?? {};
  if (typeof query !== 'string' || !query.trim() || !Array.isArray(documents) || !documents.every((d) => typeof d === 'string')) {
    return reply.status(400).send({ error: 'query must be a non-empty string and documents must be an array of strings' });
  }

  // Same privacy posture as /gateway and /embed: never send unscrubbed text
  // to a model server.
  const scrubbedQuery = scrubString(query);
  const scrubbedDocuments = documents.map((d) => scrubString(d));

  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', onClose);

  try {
    const result = await rerankerProvider.rerank(scrubbedQuery, scrubbedDocuments, controller.signal);
    return { model: result.model, scores: result.scores };
  } catch (error) {
    if (error instanceof RerankerCancelledError) {
      return reply.status(499).send({ error: error.message, errorCategory: 'RERANKER_CANCELLED' });
    }
    if (error instanceof RerankerTimeoutError) {
      return reply.status(504).send({ error: error.message, errorCategory: 'RERANKER_TIMEOUT' });
    }
    if (error instanceof RerankerInvalidResponseError) {
      return reply.status(502).send({ error: error.message, errorCategory: 'RERANKER_INVALID_RESPONSE' });
    }
    if (error instanceof RerankerUnavailableError) {
      return reply.status(503).send({ error: error.message, errorCategory: 'RERANKER_UNAVAILABLE' });
    }
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

/**
 * Phase 8 — repository issue analysis. Deliberately isolated from /gateway:
 * never routed through AiRouter/OrigamiAiGateway/TASK_MODEL_MAP, never
 * added to the AiTask union. Only ever scores/diagnoses evidence it is
 * given — never asked to fix/generate/execute anything.
 */
app.post<{ Body: { title: string; description: string; filePath?: string; symbol?: string; lineStart?: number; lineEnd?: number; evidence: EvidenceChunk[] } }>(
  '/analyze-repository-issue',
  async (request, reply) => {
    const body = request.body ?? ({} as typeof request.body);
    if (typeof body.title !== 'string' || !body.title.trim() || typeof body.description !== 'string' || !Array.isArray(body.evidence)) {
      return reply.status(400).send({ error: 'title, description, and evidence are required' });
    }

    // Same privacy posture as /gateway, /embed, /rerank: never send
    // unscrubbed text to a model server.
    const scrubbedEvidence = body.evidence.map((chunk) => ({ ...chunk, content: scrubString(chunk.content) }));

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const result = await analyzeRepositoryIssue(
        resolveRepositoryAiConfig(),
        {
          title: scrubString(body.title),
          description: scrubString(body.description),
          filePath: body.filePath,
          symbol: body.symbol,
          lineStart: body.lineStart,
          lineEnd: body.lineEnd,
          evidence: scrubbedEvidence,
        },
        controller.signal,
      );
      return result;
    } catch (error) {
      if (error instanceof RepositoryAiCancelledError) return reply.status(499).send({ error: error.message, errorCategory: 'ANALYSIS_CANCELLED' });
      if (error instanceof RepositoryAiTimeoutError) return reply.status(504).send({ error: error.message, errorCategory: 'ANALYSIS_TIMEOUT' });
      if (error instanceof RepositoryAiInvalidResponseError) return reply.status(502).send({ error: error.message, errorCategory: 'ANALYSIS_INVALID_RESPONSE' });
      if (error instanceof RepositoryAiUnavailableError) return reply.status(503).send({ error: error.message, errorCategory: 'ANALYSIS_PROVIDER_UNAVAILABLE' });
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/**
 * Phase 8 — AI fix proposal generation. Same isolation posture as
 * /analyze-repository-issue above. Returns a proposed unified diff only —
 * this route never applies anything to any filesystem; the caller
 * (apps/api's repository-fix-service.ts) is solely responsible for static
 * validation before the result is ever shown to a user.
 */
app.post<{ Body: { title: string; description: string; analysis: IssueAnalysisResult; evidence: EvidenceChunk[] } }>(
  '/propose-repository-fix',
  async (request, reply) => {
    const body = request.body ?? ({} as typeof request.body);
    if (typeof body.title !== 'string' || !body.title.trim() || typeof body.description !== 'string' || !body.analysis || !Array.isArray(body.evidence)) {
      return reply.status(400).send({ error: 'title, description, analysis, and evidence are required' });
    }

    const scrubbedEvidence = body.evidence.map((chunk) => ({ ...chunk, content: scrubString(chunk.content) }));

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const result = await proposeRepositoryFix(
        resolveRepositoryAiConfig(),
        {
          title: scrubString(body.title),
          description: scrubString(body.description),
          analysis: body.analysis,
          evidence: scrubbedEvidence,
        },
        controller.signal,
      );
      return result;
    } catch (error) {
      if (error instanceof RepositoryAiCancelledError) return reply.status(499).send({ error: error.message, errorCategory: 'PROPOSAL_CANCELLED' });
      if (error instanceof RepositoryAiTimeoutError) return reply.status(504).send({ error: error.message, errorCategory: 'PROPOSAL_TIMEOUT' });
      if (error instanceof RepositoryAiInvalidResponseError) return reply.status(502).send({ error: error.message, errorCategory: 'PROPOSAL_INVALID_RESPONSE' });
      if (error instanceof RepositoryAiUnavailableError) return reply.status(503).send({ error: error.message, errorCategory: 'PROPOSAL_PROVIDER_UNAVAILABLE' });
      throw error;
    } finally {
      reply.raw.off('close', onClose);
    }
  },
);

/**
 * Phase 9 — Repository AI Assistant grounded code Q&A. Deliberately
 * isolated from /gateway: never routed through AiRouter/OrigamiAiGateway/
 * TASK_MODEL_MAP, never added to the AiTask union. Only ever answers using
 * the bounded, already-retrieved context apps/api sends — never asked to
 * fix/generate/execute anything.
 */
app.post<{ Body: { query: string; contextText: string } }>('/answer-repository-question', async (request, reply) => {
  const body = request.body ?? ({} as typeof request.body);
  if (typeof body.query !== 'string' || !body.query.trim() || typeof body.contextText !== 'string') {
    return reply.status(400).send({ error: 'query and contextText are required' });
  }

  // Same privacy posture as /gateway, /embed, /rerank, /analyze-repository-issue: never send unscrubbed text to a model server.
  const scrubbedQuery = scrubString(body.query);
  const scrubbedContext = scrubString(body.contextText);

  const controller = new AbortController();
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.on('close', onClose);

  try {
    const result = await answerRepositoryQuestion(resolveRepositoryQaConfig(), { query: scrubbedQuery, contextText: scrubbedContext }, controller.signal);
    return result;
  } catch (error) {
    if (error instanceof RepositoryQaCancelledError) return reply.status(499).send({ error: error.message, errorCategory: 'LLM_CANCELLED' });
    if (error instanceof RepositoryQaTimeoutError) return reply.status(504).send({ error: error.message, errorCategory: 'LLM_TIMEOUT' });
    if (error instanceof RepositoryQaInvalidResponseError) return reply.status(502).send({ error: error.message, errorCategory: 'LLM_INVALID_RESPONSE' });
    if (error instanceof RepositoryQaUnavailableError) return reply.status(503).send({ error: error.message, errorCategory: 'LLM_PROVIDER_UNAVAILABLE' });
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

/**
 * Phase 10 — AI issue analysis + code fix proposal for a website-scan
 * finding. Deliberately isolated from /gateway: never routed through
 * AiRouter/OrigamiAiGateway/TASK_MODEL_MAP, never added to the AiTask
 * union. Distinct from Phase 8's /propose-repository-fix (which proposes a
 * fix for a repository issue and returns unified-diff text) — this route
 * proposes a fix for a website-scan finding and returns structured hunks.
 * Returns a proposed change description only — this route never applies
 * anything to any filesystem; apps/api's repository-finding-fix-service.ts
 * is solely responsible for static validation before the result is ever
 * shown to a user.
 */
app.post<{ Body: { contextText: string; instruction?: string } }>('/propose-finding-fix', async (request, reply) => {
  const body = request.body ?? ({} as typeof request.body);
  if (typeof body.contextText !== 'string' || !body.contextText.trim()) {
    return reply.status(400).send({ error: 'contextText is required' });
  }
  if (body.instruction !== undefined && typeof body.instruction !== 'string') {
    return reply.status(400).send({ error: 'instruction must be a string when supplied' });
  }

  const scrubbedContext = scrubString(body.contextText);
  const scrubbedInstruction = body.instruction ? scrubString(body.instruction) : undefined;

  const controller = new AbortController();
  const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.on('close', onClose);

  try {
    const result = await proposeFindingFix(resolveFindingFixConfig(), { contextText: scrubbedContext, instruction: scrubbedInstruction }, controller.signal);
    return result;
  } catch (error) {
    if (error instanceof FindingFixCancelledError) return reply.status(499).send({ error: error.message, errorCategory: 'PROPOSAL_CANCELLED' });
    if (error instanceof FindingFixTimeoutError) return reply.status(504).send({ error: error.message, errorCategory: 'LLM_TIMEOUT' });
    if (error instanceof FindingFixInvalidResponseError) return reply.status(502).send({ error: error.message, errorCategory: 'LLM_INVALID_RESPONSE' });
    if (error instanceof FindingFixUnavailableError) return reply.status(503).send({ error: error.message, errorCategory: 'LLM_PROVIDER_UNAVAILABLE' });
    throw error;
  } finally {
    reply.raw.off('close', onClose);
  }
});

app.post<{ Body: AiGatewayRequest }>('/gateway', async (request, reply) => {
  // imageBase64 (screenshot_to_code) is binary image data, not scrubbable
  // text — scrubObject's regex chain over a multi-megabyte base64 string
  // was real, measurable, synchronous CPU work (~600ms at 8MB, confirmed by
  // direct timing) for zero privacy benefit, since images were never
  // redacted this way anyway (see sanitizeComponentEvidence's own doc
  // comment, which already excludes the same field for the same reason).
  const { imageBase64, ...restPayload } = request.body.payload as Record<string, unknown> & { imageBase64?: unknown };
  const sanitizedRest = sanitizeForAi(restPayload);
  const sanitized = {
    ...request.body,
    payload: typeof imageBase64 === 'string' ? { ...sanitizedRest, imageBase64 } : sanitizedRest,
  };

  // Real end-to-end cancellation: if the caller (component-generator.ts's
  // callGateway — whether its own outer timeout fired, or the worker
  // aborted it for a user's Stop Generation click) disconnects before this
  // completes, abort the downstream Ollama call too. Without this, the
  // model call keeps running to completion on the GPU regardless of what
  // the caller does — empirically confirmed to be the actual cause of the
  // previously-diagnosed "orphaned generation" behavior, not any Ollama
  // limitation (aborting the direct fetch to Ollama reliably releases the
  // GPU within ~1s once it's actually told to stop).
  const controller = new AbortController();
  const onClose = () => {
    // reply.raw's 'close' event fires both for a premature disconnect AND
    // for ordinary post-response socket teardown (Node's documented
    // behavior for http.ServerResponse) — only cancel when the response
    // hasn't actually finished, so a normal completed request is never
    // mistaken for a cancellation.
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  };
  reply.raw.on('close', onClose);
  try {
    return await router.route(sanitized, controller.signal);
  } finally {
    reply.raw.off('close', onClose);
  }
});

app.post<{ Body: ExplainIssueRequest }>('/explain-issue', async (request) => {
  const { issue, evidence } = request.body;
  const response = await router.route({
    task: 'explain_issue',
    payload: sanitizeForAi({ issue, evidence }),
  });
  return {
    explanation: response.result ?? {},
    aiAvailable: response.success && response.model !== 'deterministic-fallback',
    error: response.error,
  };
});

app.post<{ Body: AskRequest }>('/ask', async (request) => {
  const { question, url, issue, evidence } = request.body;
  const task = question.toLowerCase().includes('visual') || question.toLowerCase().includes('look')
    ? 'visual_qa' as const
    : 'ask' as const;

  const response = await router.route({
    task,
    payload: sanitizeForAi({ question, url, issue, evidence }),
  });

  return {
    answer: (response.result?.answer as string) ?? (response.result?.problem as string) ?? 'AI explanation unavailable.',
    aiAvailable: response.success && response.model !== 'deterministic-fallback',
    error: response.error,
  };
});

app.post<{ Body: Record<string, unknown> }>('/suggest-fix', async (request) => {
  const response = await router.route({
    task: 'fix_code',
    payload: sanitizeForAi(request.body),
  });
  return {
    fix: response.result ?? {},
    aiAvailable: response.success && response.model !== 'deterministic-fallback',
    error: response.error,
  };
});

async function start() {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`AI Router listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
