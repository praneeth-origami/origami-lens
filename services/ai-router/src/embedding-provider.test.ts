import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BgeM3EmbeddingProvider,
  EmbeddingCancelledError,
  EmbeddingInvalidResponseError,
  EmbeddingTimeoutError,
  EmbeddingUnavailableError,
  resolveEmbeddingConfig,
} from './embedding-provider.js';

const CONFIG = { baseUrl: 'http://fake-model-server/v1', apiKey: 'test-key', model: 'bge-m3', timeoutMs: 5000 };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchArgs = Parameters<typeof fetch>;

function mockFetchOnce(handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response> | Response) {
  globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => Promise.resolve(handler(input, init))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('BgeM3EmbeddingProvider.embedBatch', () => {
  it('TEST 1 — single text embedding returns the real vector and dimension', async () => {
    mockFetchOnce(() => jsonResponse({ model: 'bge-m3', data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const result = await provider.embedBatch(['function add(a, b) { return a + b; }']);
    assert.equal(result.model, 'bge-m3');
    assert.equal(result.dimensions, 3);
    assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]]);
  });

  it('TEST 2 — batch embedding sends all texts in one request and returns one vector per input', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return jsonResponse({
        model: 'bge-m3',
        data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }, { embedding: [0, 0, 1] }],
      });
    });
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const result = await provider.embedBatch(['a', 'b', 'c']);
    assert.equal(result.vectors.length, 3);
    assert.equal(result.dimensions, 3);
    assert.deepEqual((capturedBody as { input: string[] }).input, ['a', 'b', 'c']);
  });

  it('TEST 8 — empty input is handled without making any request', async () => {
    let called = false;
    mockFetchOnce(() => {
      called = true;
      return jsonResponse({ data: [] });
    });
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const result = await provider.embedBatch([]);
    assert.equal(called, false);
    assert.deepEqual(result.vectors, []);
    assert.equal(result.dimensions, 0);
  });

  it('TEST 3 — a request that exceeds the configured timeout throws EmbeddingTimeoutError', async () => {
    // A real fetch rejects with a `TimeoutError`-named exception once the
    // AbortSignal.timeout() it was given fires — reproduced directly here
    // (rather than actually waiting out a real timer) so this test is
    // instant and deterministic, independent of real event-loop timing.
    globalThis.fetch = (() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))) as typeof fetch;
    const provider = new BgeM3EmbeddingProvider({ ...CONFIG, timeoutMs: 20 });
    await assert.rejects(() => provider.embedBatch(['slow']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingTimeoutError);
      assert.equal(error.timeoutMs, 20);
      return true;
    });
  });

  it('TEST 4 — an externally aborted signal throws EmbeddingCancelledError, not a timeout', async () => {
    // A real fetch rejects with an AbortError once its signal fires —
    // reproduced directly; the signal passed to embedBatch is already
    // aborted before the call starts, so this is instant and deterministic.
    globalThis.fetch = (() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))) as typeof fetch;
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider.embedBatch(['x'], controller.signal), (error: unknown) => {
      assert.ok(error instanceof EmbeddingCancelledError);
      return true;
    });
  });

  it('TEST 5 — provider unavailable (network error) throws EmbeddingUnavailableError', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['x']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingUnavailableError);
      return true;
    });
  });

  it('TEST 5b — provider unavailable (non-2xx HTTP response) throws EmbeddingUnavailableError with the status code', async () => {
    mockFetchOnce(() => jsonResponse({ error: 'model not found' }, 404));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['x']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingUnavailableError);
      assert.equal(error.statusCode, 404);
      return true;
    });
  });

  it('TEST 6 — an invalid response body (missing data array) throws EmbeddingInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ notData: [] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['x']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingInvalidResponseError);
      return true;
    });
  });

  it('a non-JSON response body throws EmbeddingInvalidResponseError', async () => {
    mockFetchOnce(() => new Response('not json', { status: 200 }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['x']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingInvalidResponseError);
      return true;
    });
  });

  it('TEST 7 — inconsistent per-vector dimensions within one batch throws EmbeddingInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2] }] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['a', 'b']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingInvalidResponseError);
      return true;
    });
  });

  it('a non-numeric-array embedding entry throws EmbeddingInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ embedding: 'not-an-array' }] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    await assert.rejects(() => provider.embedBatch(['x']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingInvalidResponseError);
      return true;
    });
  });
});

describe('BgeM3EmbeddingProvider.isModelAvailable', () => {
  it('reports available: true when the configured model is in the server model list', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ id: 'bge-m3' }, { id: 'qwen2.5:7b' }] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const status = await provider.isModelAvailable();
    assert.equal(status.reachable, true);
    assert.equal(status.available, true);
  });

  it('reports available: false when the configured model is missing from the server model list', async () => {
    mockFetchOnce(() => jsonResponse({ data: [{ id: 'qwen2.5:7b' }] }));
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const status = await provider.isModelAvailable();
    assert.equal(status.reachable, true);
    assert.equal(status.available, false);
  });

  it('reports reachable: false when the server cannot be reached at all', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const provider = new BgeM3EmbeddingProvider(CONFIG);
    const status = await provider.isModelAvailable();
    assert.equal(status.reachable, false);
    assert.equal(status.available, false);
  });
});

describe('resolveEmbeddingConfig', () => {
  beforeEach(() => {
    delete process.env.AI_EMBED_MODEL;
    delete process.env.AI_EMBED_TIMEOUT_MS;
  });

  it('reuses the existing AI_EMBED_MODEL variable (already referenced by gateway.ts) rather than inventing a new one', () => {
    process.env.AI_EMBED_MODEL = 'bge-m3-custom';
    const config = resolveEmbeddingConfig();
    assert.equal(config.model, 'bge-m3-custom');
  });

  it('falls back to a safe default timeout for an invalid AI_EMBED_TIMEOUT_MS', () => {
    process.env.AI_EMBED_TIMEOUT_MS = 'not-a-number';
    const config = resolveEmbeddingConfig();
    assert.equal(config.timeoutMs, 30_000);
  });

  it('honors a valid AI_EMBED_TIMEOUT_MS', () => {
    process.env.AI_EMBED_TIMEOUT_MS = '15000';
    const config = resolveEmbeddingConfig();
    assert.equal(config.timeoutMs, 15000);
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_EMBED_MODEL = 'from-env';
    const config = resolveEmbeddingConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
  });
});
