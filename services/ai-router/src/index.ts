import './load-env.js';
import Fastify from 'fastify';
import type { AiGatewayRequest, AskRequest, ExplainIssueRequest } from '@origami/contracts';
import { sanitizeForAi } from '@origami/privacy';
import { AiRouter } from './gateway.js';

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

const app = Fastify({ logger: true, bodyLimit: MAX_REQUEST_BODY_BYTES });

app.get('/health', async () => ({ status: 'ok', service: 'ai-router' }));

// Real capability check — distinct from /health, which only confirms this
// process is up. This confirms the configured model server is reachable AND
// that the specific models each AI task needs are actually deployed there.
app.get('/health/models', async () => router.checkModelAvailability());

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
