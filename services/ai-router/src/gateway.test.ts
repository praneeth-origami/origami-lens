import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AiRouter, OrigamiAiGateway, TASK_MODEL_MAP } from './gateway.js';

/** Minimal OpenAI-compatible stub server for the model-availability and callVllm tests. */
function startStubModelServer(opts: {
  models?: string[];
  chatStatus?: number;
  chatBody?: unknown;
  delayMs?: number;
  /** Ollama-style native /api/tags payload — only needed by the resource-fit tests. */
  tags?: Array<{ name: string; size: number }>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const { models = ['qwen2.5:7b'], chatStatus = 200, chatBody, delayMs = 0, tags } = opts;

  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/api/tags')) {
      if (!tags) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: tags }));
      return;
    }
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      setTimeout(() => {
        res.writeHead(chatStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chatBody ?? { error: { message: 'not found' } }));
      }, delayMs);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('Origami AI Gateway', () => {
  it('routes tasks to documented models', () => {
    assert.equal(TASK_MODEL_MAP.explain_issue, 'qwen2.5:7b');
    assert.equal(TASK_MODEL_MAP.summarize_scan, 'qwen2.5:7b');
    assert.equal(TASK_MODEL_MAP.ask, 'qwen2.5:7b');
    assert.equal(TASK_MODEL_MAP.fix_code, 'qwen2.5:7b');
    assert.equal(TASK_MODEL_MAP.visual_qa, 'Qwen3-VL-8B-Instruct');
    assert.equal(TASK_MODEL_MAP.ocr, 'PaddleOCR-VL-1.6');
  });

  it('falls back when AI is disabled', async () => {
    const router = new AiRouter({ enabled: false });
    const response = await router.route({
      task: 'explain_issue',
      payload: {
        issue: {
          id: '1',
          category: 'seo',
          type: 'MISSING_TITLE',
          severity: 'HIGH',
          title: 'Missing page title',
          evidence: {},
          confidence: 0.95,
          impact: 'SEO impact',
          source: 'origami-rule',
          problem: 'No title',
          cause: 'Empty title',
          suggestedFix: 'Add title',
        },
      },
    });
    assert.equal(response.success, true);
    assert.equal(response.model, 'deterministic-fallback');
    assert.ok(response.result?.problem);
  });

  it('visual_qa fallback returns empty findings', async () => {
    const router = new AiRouter({ enabled: false });
    const response = await router.route({
      task: 'visual_qa',
      payload: { url: 'http://localhost:8080', imageBase64: 'abc', viewport: 'desktop' },
    });
    assert.equal(response.success, true);
    assert.equal(response.model, 'deterministic-fallback');
    assert.deepEqual(response.result?.findings, []);
  });

  it('routes Screenshot -> Code tasks to the vision and coding models', () => {
    assert.equal(TASK_MODEL_MAP.screenshot_to_code, 'Qwen3-VL-8B-Instruct');
    assert.equal(TASK_MODEL_MAP.generate_component, 'Qwen3-Coder-Next');
  });

  it('generate_component has no fabricated fallback — honest failure instead', async () => {
    const router = new AiRouter({ enabled: false });
    const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
    assert.equal(response.success, false);
    assert.equal(response.error, 'Code generation is temporarily unavailable.');
    assert.equal(response.result, undefined);
  });

  it('preserves the friendly fallback message instead of a raw connection error', async () => {
    const router = new AiRouter({ enabled: true, baseUrl: 'http://127.0.0.1:1/v1' });
    const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
    assert.equal(response.success, false);
    assert.equal(response.error, 'Code generation is temporarily unavailable.');
  });
});

describe('checkModelAvailability', () => {
  it('reports healthy when the provider is reachable and all required models are present', async () => {
    const stub = await startStubModelServer({
      models: ['qwen2.5:7b', 'Qwen3-VL-8B-Instruct', 'Qwen3-Coder-Next'],
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const report = await gateway.checkModelAvailability();
      assert.equal(report.enabled, true);
      assert.equal(report.reachable, true);
      assert.ok(report.requiredModels.every((m) => m.available));
    } finally {
      await stub.close();
    }
  });

  it('reports the vision model as unavailable when only a general text model is deployed (reproduces the real Screenshot -> Code failure)', async () => {
    // This is exactly the observed production scenario: Ollama running and
    // reachable, but only qwen2.5:7b pulled — neither Qwen3-VL-8B-Instruct
    // nor Qwen3-Coder-Next present.
    const stub = await startStubModelServer({ models: ['qwen2.5:7b'] });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const report = await gateway.checkModelAvailability();
      assert.equal(report.reachable, true);
      const vision = report.requiredModels.find((m) => m.task === 'screenshot_to_code');
      const coding = report.requiredModels.find((m) => m.task === 'generate_component');
      assert.equal(vision?.available, false);
      assert.equal(coding?.available, false);
      const textTask = report.requiredModels.find((m) => m.task === 'ask');
      assert.equal(textTask?.available, true);
    } finally {
      await stub.close();
    }
  });

  it('reports unreachable when the provider connection is refused', async () => {
    const gateway = new OrigamiAiGateway({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', enabled: true });
    const report = await gateway.checkModelAvailability();
    assert.equal(report.reachable, false);
    assert.ok(report.error);
    assert.ok(report.requiredModels.every((m) => m.available === false));
  });

  it('reports disabled without attempting a network call when AI_ENABLED is false', async () => {
    const gateway = new OrigamiAiGateway({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', enabled: false });
    const report = await gateway.checkModelAvailability();
    assert.equal(report.enabled, false);
    assert.equal(report.reachable, false);
  });
});

describe('screenshot_to_code / generate_component failure diagnostics', () => {
  it('surfaces the model-not-found status via a structured error, and only a safe generic message to the caller', async () => {
    const stub = await startStubModelServer({
      chatStatus: 404,
      chatBody: { error: { message: "model 'Qwen3-VL-8B-Instruct' not found" } },
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({
        task: 'screenshot_to_code',
        payload: { imageBase64: 'abc', sourceUrl: 'https://example.com' },
      });
      assert.equal(response.success, false);
      // User/caller-facing message stays generic — never the raw "model not found" detail.
      assert.equal(response.error, 'Code generation is temporarily unavailable.');
      assert.ok(!response.error?.includes('Qwen3-VL'));
    } finally {
      await stub.close();
    }
  });

  it('logs a structured, non-sensitive diagnostic event when a task falls back, without leaking the request payload', async () => {
    const stub = await startStubModelServer({ chatStatus: 500, chatBody: { error: 'boom' } });
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      await router.route({
        task: 'generate_component',
        payload: { target: 'REACT', html: '<div>super-secret-page-content</div>' },
      });

      const logged = errorSpy.mock.calls.map((c) => String(c.arguments[0]));
      const diagLine = logged.find((l) => l.includes('"event":"ai_unavailable"'));
      assert.ok(diagLine, 'expected a structured ai_unavailable log line');

      const parsed = JSON.parse(diagLine!);
      assert.equal(parsed.task, 'generate_component');
      assert.equal(parsed.model, 'Qwen3-Coder-Next');
      assert.equal(parsed.statusCode, 500);
      assert.ok(parsed.reason);
      // The diagnostic must never contain the actual page content sent in the payload.
      assert.ok(!diagLine!.includes('super-secret-page-content'));
    } finally {
      errorSpy.mock.restore();
      await stub.close();
    }
  });

  it('a healthy model server produces a real success response for generate_component', async () => {
    const stub = await startStubModelServer({
      chatStatus: 200,
      chatBody: {
        choices: [{ message: { content: JSON.stringify({ componentName: 'PricingCard', files: [{ path: 'a.jsx', content: 'x' }], dependencies: [], notes: [] }) } }],
      },
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, true);
      assert.equal(response.model, 'Qwen3-Coder-Next');
      assert.equal((response.result as { componentName: string }).componentName, 'PricingCard');
    } finally {
      await stub.close();
    }
  });
});

describe('response parsing — the actual root cause of the "false unavailable" reports', () => {
  it('parses a markdown-fenced JSON response instead of failing (reproduces the observed 4/6 failure mode)', async () => {
    const realJson = JSON.stringify({ componentName: 'PricingCard', files: [{ path: 'a.jsx', content: 'x' }], dependencies: [], notes: [] });
    const stub = await startStubModelServer({
      chatStatus: 200,
      chatBody: { choices: [{ message: { content: '```json\n' + realJson + '\n```' } }] },
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, true, 'a fenced-but-valid JSON response must not be treated as a failure');
      assert.equal(response.model, 'Qwen3-Coder-Next');
      assert.equal((response.result as { componentName: string }).componentName, 'PricingCard');
    } finally {
      await stub.close();
    }
  });

  it('parses JSON with stray prose before/after the object', async () => {
    const stub = await startStubModelServer({
      chatStatus: 200,
      chatBody: { choices: [{ message: { content: 'Sure, here you go:\n{"componentName":"Navbar","files":[{"path":"a.jsx","content":"x"}],"dependencies":[],"notes":[]}\nHope that helps!' } }] },
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, true);
      assert.equal((response.result as { componentName: string }).componentName, 'Navbar');
    } finally {
      await stub.close();
    }
  });

  it('classifies truncated/invalid JSON as a parse failure, NOT "temporarily unavailable" (reproduces the observed 1/6 failure mode)', async () => {
    const stub = await startStubModelServer({
      chatStatus: 200,
      // Simulates output cut off mid-string by max_tokens, as seen in production logs.
      chatBody: { choices: [{ message: { content: '{"componentName":"PricingCard","files":[{"path":"a.jsx","content":"export function Pricing' } }] },
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, false);
      assert.equal(response.error, 'The AI generated a response that could not be processed. Please try again.');
      assert.notEqual(response.error, 'Code generation is temporarily unavailable.', 'must not blame availability for a parsing failure');
    } finally {
      await stub.close();
    }
  });

  it('logs the parse failure under a distinct event name from genuine unavailability, with no page content and no raw model output', async () => {
    const stub = await startStubModelServer({
      chatStatus: 200,
      chatBody: { choices: [{ message: { content: '```json\n{"componentName":"Broken", "files": [' } }] },
    });
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      await router.route({ task: 'generate_component', payload: { target: 'REACT', html: '<div>super-secret-page-content</div>' } });

      const logged = errorSpy.mock.calls.map((c) => String(c.arguments[0]));
      const diagLine = logged.find((l) => l.includes('"event":"ai_response_parse_failed"'));
      assert.ok(diagLine, 'expected a distinct ai_response_parse_failed log line');
      assert.ok(!logged.some((l) => l.includes('"event":"ai_unavailable"')), 'must not also log this as a generic unavailability event');
      assert.ok(!diagLine!.includes('super-secret-page-content'));
    } finally {
      errorSpy.mock.restore();
      await stub.close();
    }
  });

  it('requests a larger token budget for generate_component than the default (root cause of the truncation failure mode)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        capturedBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"componentName":"X","files":[],"dependencies":[],"notes":[]}' } }] }));
      });
    });
    const url: string = await new Promise((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/v1`);
      });
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: url });
      await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.ok(capturedBody);
      assert.equal(capturedBody!.max_tokens, 4096);
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });
});

describe('inference timeout — distinct from "temporarily unavailable" (reproduces the RTX 3050 / 6GB VRAM failure mode)', () => {
  const originalTimeout = process.env.AI_MODEL_TIMEOUT_MS;
  const originalCodeTimeout = process.env.AI_CODE_GENERATION_TIMEOUT_MS;
  const originalBudget = process.env.AI_GPU_VRAM_MB;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.AI_MODEL_TIMEOUT_MS;
    else process.env.AI_MODEL_TIMEOUT_MS = originalTimeout;
    // generate_component now uses its own AI_CODE_GENERATION_TIMEOUT_MS
    // (Step 8) rather than sharing AI_MODEL_TIMEOUT_MS — these tests target
    // generate_component specifically, so this is the one that must be set.
    if (originalCodeTimeout === undefined) delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
    else process.env.AI_CODE_GENERATION_TIMEOUT_MS = originalCodeTimeout;
    if (originalBudget === undefined) delete process.env.AI_GPU_VRAM_MB;
    else process.env.AI_GPU_VRAM_MB = originalBudget;
  });

  it('reports a plain timeout (not "temporarily unavailable") when generate_component exceeds the configured budget and no GPU budget is configured', async () => {
    delete process.env.AI_GPU_VRAM_MB;
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '100';
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"componentName":"X","files":[],"dependencies":[],"notes":[]}' } }] },
      delayMs: 500,
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, false);
      assert.equal(response.error, 'Code generation timed out. Please try again.');
      assert.notEqual(response.error, 'Code generation is temporarily unavailable.');
    } finally {
      await stub.close();
    }
  });

  it('reports a resource/configuration-specific message when the timed-out model is known to be too large for the configured GPU budget', async () => {
    process.env.AI_GPU_VRAM_MB = '6'; // 6MB budget — any real model exceeds this
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '100';
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"componentName":"X","files":[],"dependencies":[],"notes":[]}' } }] },
      delayMs: 500,
      tags: [{ name: 'Qwen3-Coder-Next', size: 18_000_000_000 }],
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, false);
      assert.equal(response.error, 'Code generation could not be completed with the current AI configuration.');
    } finally {
      await stub.close();
    }
  });

  it('does not misclassify a timeout as resource-constrained when the model fits the configured budget (a slow-but-right-sized model is a plain timeout)', async () => {
    process.env.AI_GPU_VRAM_MB = '20000'; // 20GB — comfortably fits the stubbed model below
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '100';
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"componentName":"X","files":[],"dependencies":[],"notes":[]}' } }] },
      delayMs: 500,
      tags: [{ name: 'Qwen3-Coder-Next', size: 1_000_000_000 }],
    });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.error, 'Code generation timed out. Please try again.');
    } finally {
      await stub.close();
    }
  });

  it('leaves other tasks (with real deterministic fallbacks) unaffected by timeout classification', async () => {
    process.env.AI_MODEL_TIMEOUT_MS = '100';
    const stub = await startStubModelServer({ chatBody: { choices: [{ message: { content: '{}' } }] }, delayMs: 500 });
    try {
      const router = new AiRouter({ enabled: true, baseUrl: stub.url });
      const response = await router.route({ task: 'ask', payload: { question: 'why?' } });
      // ask has a real deterministic fallback and must keep degrading gracefully, not surface a raw timeout message.
      assert.equal(response.success, true);
      assert.equal(response.model, 'deterministic-fallback');
    } finally {
      await stub.close();
    }
  });
});

describe('checkModelAvailability — resource-aware readiness', () => {
  const originalBudget = process.env.AI_GPU_VRAM_MB;
  afterEach(() => {
    if (originalBudget === undefined) delete process.env.AI_GPU_VRAM_MB;
    else process.env.AI_GPU_VRAM_MB = originalBudget;
  });

  it('flags an oversized model as available-but-not-ready, and does not treat an unconfigured budget as a reason to mark anything not-ready', async () => {
    delete process.env.AI_GPU_VRAM_MB;
    const stub = await startStubModelServer({ models: ['qwen2.5:7b', 'Qwen3-Coder-Next'] });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const report = await gateway.checkModelAvailability();
      const coding = report.requiredModels.find((m) => m.task === 'generate_component');
      assert.equal(coding?.available, true);
      assert.equal(coding?.fitsBudget, undefined, 'no budget configured -> unknown, not "doesn\'t fit"');
      assert.equal(coding?.ready, true, 'available and unknown-fit must still be ready (never guess unfit)');
    } finally {
      await stub.close();
    }
  });

  it('marks a model registered but far larger than the configured GPU budget as not-ready, reproducing the 30B-coder-on-a-6GB-GPU scenario', async () => {
    process.env.AI_GPU_VRAM_MB = '6144'; // this project's actual dev GPU (RTX 3050, nvidia-smi)
    const stub = await startStubModelServer({
      models: ['qwen2.5:7b', 'Qwen3-VL-8B-Instruct', 'Qwen3-Coder-Next'],
      tags: [
        { name: 'qwen2.5:7b', size: 4_700_000_000 }, // ~4.7GB — this project's chosen dev code model
        { name: 'Qwen3-VL-8B-Instruct', size: 6_140_415_975 }, // real qwen3-vl:8b-instruct size — fits despite being close to the budget
        { name: 'Qwen3-Coder-Next', size: 18_556_700_761 }, // real qwen3-coder:30b size — this is what was timing out
      ],
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const report = await gateway.checkModelAvailability();
      const text = report.requiredModels.find((m) => m.task === 'ask');
      const vision = report.requiredModels.find((m) => m.task === 'screenshot_to_code');
      const coding = report.requiredModels.find((m) => m.task === 'generate_component');

      assert.equal(text?.fitsBudget, true, 'qwen2.5:7b (~4.7GB) must fit a 6144MB budget');
      assert.equal(vision?.fitsBudget, true, 'the vision model (~6.1GB) has demonstrated reliable real-world use at this size and must not be flagged unfit');
      assert.equal(coding?.available, true, 'the 30B model IS registered with the server');
      assert.equal(coding?.fitsBudget, false, 'but at ~18GB it is ~3x the configured 6144MB budget');
      assert.equal(coding?.ready, false, 'registered-but-oversized must not read as ready — this is exactly the aiAvailable=true-but-generation-fails gap');
    } finally {
      await stub.close();
    }
  });
});

describe('OrigamiAiGateway.execute — external cancellation propagation', () => {
  /** A model-server stub that never responds, so it stays busy until the caller gives up one way or another — with `req.on('close')` tracking exactly like the real Ollama-abort investigation used. */
  function startNeverRespondingStub(): Promise<{ url: string; sawClose: () => boolean; close: () => Promise<void> }> {
    let closed = false;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('close', () => {
        if (!res.writableEnded) closed = true;
      });
      // Never respond.
    });
    return new Promise((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          sawClose: () => closed,
          // closeAllConnections(): an aborted fetch doesn't always fully
          // tear down its TCP socket the instant the client gives up on it
          // (an undici/Node quirk, unrelated to the cancellation code under
          // test) — server.close() alone would then wait ~4s for that
          // lingering socket before its callback fires.
          close: () => { server.closeAllConnections(); return new Promise((r) => server.close(() => r())); },
        });
      });
    });
  }

  it('reports CLIENT_DISCONNECTED (not MODEL_TIMEOUT) when an external signal aborts before the internal AI_MODEL_TIMEOUT_MS budget — and the underlying model-server connection is actually closed', async () => {
    const originalTimeout = process.env.AI_MODEL_TIMEOUT_MS;
    process.env.AI_MODEL_TIMEOUT_MS = '30000'; // deliberately much longer than when we'll abort, so only the external signal can be what fires
    const stub = await startNeverRespondingStub();
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);

      const response = await gateway.execute(
        { task: 'ask', payload: { question: 'hi' } },
        controller.signal,
      );

      assert.equal(response.success, false);
      assert.equal(response.errorCategory, 'CLIENT_DISCONNECTED');
      assert.notEqual(response.errorCategory, 'MODEL_TIMEOUT', 'an external abort must never be misreported as the internal timeout firing');

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(stub.sawClose(), true, 'the outbound connection to the model server must actually be closed, not just abandoned client-side');
    } finally {
      // process.env.X = undefined stringifies to the literal "undefined",
      // it does not unset the variable — must delete when there was none.
      if (originalTimeout === undefined) delete process.env.AI_MODEL_TIMEOUT_MS;
      else process.env.AI_MODEL_TIMEOUT_MS = originalTimeout;
      await stub.close();
    }
  });

  it('still reports MODEL_TIMEOUT (not CLIENT_DISCONNECTED) when the internal budget fires and no external signal was ever aborted', async () => {
    const originalTimeout = process.env.AI_MODEL_TIMEOUT_MS;
    process.env.AI_MODEL_TIMEOUT_MS = '30';
    const stub = await startNeverRespondingStub();
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const controller = new AbortController(); // never aborted — only the internal timeout should fire

      // screenshot_to_code (unlike 'ask') has no deterministic fallback —
      // a timeout must report success:false, not a graceful stand-in answer.
      const response = await gateway.execute(
        { task: 'screenshot_to_code', payload: {} },
        controller.signal,
      );

      assert.equal(response.success, false);
      assert.equal(response.errorCategory, 'MODEL_TIMEOUT');
      assert.notEqual(response.errorCategory, 'CLIENT_DISCONNECTED', 'the internal timeout firing must never be misreported as a client disconnect');
    } finally {
      if (originalTimeout === undefined) delete process.env.AI_MODEL_TIMEOUT_MS;
      else process.env.AI_MODEL_TIMEOUT_MS = originalTimeout;
      await stub.close();
    }
  });

  it('a real (non-external-signal) call is unaffected by another job\'s AbortController — cancellation is per-request, never global', async () => {
    const stub = await startStubModelServer({ chatBody: { choices: [{ message: { content: '{"answer":"ok","confidence":1}' } }] } });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const jobAController = new AbortController();
      const jobBController = new AbortController();

      // Job A is cancelled...
      jobAController.abort();
      // ...but Job B, with its own independent controller, must complete normally.
      const responseB = await gateway.execute({ task: 'ask', payload: { question: 'hi' } }, jobBController.signal);

      assert.equal(responseB.success, true, "cancelling job A's signal must never affect job B's independent request");
    } finally {
      await stub.close();
    }
  });
});

// Step 8: generate_component's own AI_CODE_GENERATION_TIMEOUT_MS, separate
// from AI_MODEL_TIMEOUT_MS (which continues to govern screenshot_to_code and
// every other task) — root-caused against a real production job that was
// healthy and actively generating at ~26.7 tokens/sec but got cut off by the
// shared 60s budget before finishing a larger real component.
describe('generate_component — dedicated AI_CODE_GENERATION_TIMEOUT_MS (Step 8)', () => {
  const originalModelTimeout = process.env.AI_MODEL_TIMEOUT_MS;
  const originalCodeTimeout = process.env.AI_CODE_GENERATION_TIMEOUT_MS;

  afterEach(() => {
    if (originalModelTimeout === undefined) delete process.env.AI_MODEL_TIMEOUT_MS;
    else process.env.AI_MODEL_TIMEOUT_MS = originalModelTimeout;
    if (originalCodeTimeout === undefined) delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
    else process.env.AI_CODE_GENERATION_TIMEOUT_MS = originalCodeTimeout;
  });

  /** A model-server stub that never responds, tracking whether the outbound connection was actually closed — same technique used to empirically prove real cancellation elsewhere in this file. */
  function startNeverRespondingStub(): Promise<{ url: string; sawClose: () => boolean; close: () => Promise<void> }> {
    let closed = false;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('close', () => { if (!res.writableEnded) closed = true; });
    });
    return new Promise((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/v1`,
          sawClose: () => closed,
          close: () => { server.closeAllConnections(); return new Promise((r) => server.close(() => r())); },
        });
      });
    });
  }

  it('TEST 1 — screenshot_to_code still uses AI_MODEL_TIMEOUT_MS, unaffected by AI_CODE_GENERATION_TIMEOUT_MS', async () => {
    process.env.AI_MODEL_TIMEOUT_MS = '80';
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '30000'; // deliberately much larger — if this fired instead, the call would NOT time out at ~80ms
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{}' } }] },
      delayMs: 2000,
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const t0 = Date.now();
      const response = await gateway.execute({ task: 'screenshot_to_code', payload: { imageBase64: 'abc' } });
      const elapsed = Date.now() - t0;
      assert.equal(response.success, false);
      assert.equal(response.errorCategory, 'MODEL_TIMEOUT');
      assert.ok(elapsed < 2000, `expected AI_MODEL_TIMEOUT_MS (80ms) to fire, not wait for the 2000ms stub delay or the 30000ms code timeout; took ${elapsed}ms`);
    } finally {
      await stub.close();
    }
  });

  it('TEST 2 — generate_component uses its own AI_CODE_GENERATION_TIMEOUT_MS, unaffected by AI_MODEL_TIMEOUT_MS', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '80';
    process.env.AI_MODEL_TIMEOUT_MS = '30000'; // deliberately much larger — proves this is NOT what fires
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{}' } }] },
      delayMs: 2000,
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const t0 = Date.now();
      const response = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } });
      const elapsed = Date.now() - t0;
      assert.equal(response.success, false);
      assert.ok(elapsed < 2000, `expected AI_CODE_GENERATION_TIMEOUT_MS (80ms) to fire, not wait for the 2000ms stub delay or the 30000ms model timeout; took ${elapsed}ms`);
    } finally {
      await stub.close();
    }
  });

  it('TEST 3 — the dedicated code timeout produces errorCategory MODEL_TIMEOUT, not a new category', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '80';
    const stub = await startStubModelServer({ chatBody: { choices: [{ message: { content: '{}' } }] }, delayMs: 2000 });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const response = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.errorCategory, 'MODEL_TIMEOUT');
      assert.equal(response.error, 'Code generation timed out. Please try again.');
    } finally {
      await stub.close();
    }
  });

  it('TEST 4 — the dedicated code timeout still aborts the underlying Ollama connection (real cancellation, not abandonment)', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '80';
    const stub = await startNeverRespondingStub();
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const response = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.errorCategory, 'MODEL_TIMEOUT');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(stub.sawClose(), true, 'the outbound connection to the model server must actually be closed, not just abandoned client-side');
    } finally {
      await stub.close();
    }
  });

  it('TEST 5 — a caller-provided AbortSignal still works for generate_component (CLIENT_DISCONNECTED, not MODEL_TIMEOUT)', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '30000'; // deliberately much longer than when we'll abort, so only the external signal can be what fires
    const stub = await startNeverRespondingStub();
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const response = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } }, controller.signal);
      assert.equal(response.errorCategory, 'CLIENT_DISCONNECTED');
      assert.notEqual(response.errorCategory, 'MODEL_TIMEOUT', 'an external abort must never be misreported as the dedicated code timeout firing');
    } finally {
      await stub.close();
    }
  });

  it('TEST 6 — cancellation remains per-job for generate_component (Job A\'s abort never affects Job B\'s independent generate_component call)', async () => {
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"componentName":"X","files":[{"path":"a.jsx","content":"x"}],"dependencies":[],"notes":[]}' } }] },
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const jobA = new AbortController();
      const jobB = new AbortController();
      jobA.abort();
      const responseB = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } }, jobB.signal);
      assert.equal(responseB.success, true, "cancelling job A must never affect job B's independent generate_component call");
    } finally {
      await stub.close();
    }
  });

  it('TEST 7 — with both env vars unset, generate_component\'s default budget comfortably allows a normal (non-pathological) delayed response to complete', async () => {
    delete process.env.AI_MODEL_TIMEOUT_MS;
    delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"componentName":"X","files":[{"path":"a.jsx","content":"x"}],"dependencies":[],"notes":[]}' } }] },
      delayMs: 200, // a real network/model round trip, nowhere near the documented 180s default
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const response = await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } });
      assert.equal(response.success, true, 'the default AI_CODE_GENERATION_TIMEOUT_MS must not be some accidentally tiny value');
    } finally {
      await stub.close();
    }
  });

  it('TEST 8 — an invalid AI_CODE_GENERATION_TIMEOUT_MS falls back to the documented 180000ms default, logged explicitly', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '-50'; // negative — invalid
    const stub = await startNeverRespondingStub();
    const errorSpy = mock.method(console, 'error', () => {});
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20); // abort quickly — we only need the validation log, not to actually wait out the 180s default
      await gateway.execute({ task: 'generate_component', payload: { target: 'REACT' } }, controller.signal);

      const logged = errorSpy.mock.calls.map((c) => String(c.arguments[0]));
      const diagLine = logged.find((l) => l.includes('"label":"AI_CODE_GENERATION_TIMEOUT_MS"'));
      assert.ok(diagLine, 'expected an invalid_timeout_config diagnostic for AI_CODE_GENERATION_TIMEOUT_MS');
      const parsed = JSON.parse(diagLine!);
      assert.equal(parsed.fallbackMs, 180000);
    } finally {
      errorSpy.mock.restore();
      await stub.close();
    }
  });

  it('TEST 9 — an unrelated task (ask) never receives the code-generation timeout even when it is configured very short', async () => {
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '50'; // if 'ask' accidentally used this, the delayed stub below would time it out
    delete process.env.AI_MODEL_TIMEOUT_MS; // falls back to its own generous default
    const stub = await startStubModelServer({
      chatBody: { choices: [{ message: { content: '{"answer":"ok","confidence":1}' } }] },
      delayMs: 200,
    });
    try {
      const gateway = new OrigamiAiGateway({ baseUrl: stub.url, apiKey: 'k', enabled: true });
      const response = await gateway.execute({ task: 'ask', payload: { question: 'hi' } });
      assert.equal(response.success, true, "'ask' must use AI_MODEL_TIMEOUT_MS, never the 50ms AI_CODE_GENERATION_TIMEOUT_MS");
    } finally {
      await stub.close();
    }
  });
});
