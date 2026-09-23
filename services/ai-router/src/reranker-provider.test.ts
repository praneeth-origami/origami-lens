import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BgeRerankerProvider,
  RerankerCancelledError,
  RerankerConfigurationError,
  RerankerInvalidResponseError,
  RerankerTimeoutError,
  RerankerUnavailableError,
  resolveRerankerConfig,
} from './reranker-provider.js';

const CONFIG = {
  baseUrl: 'http://fake-reranker-server',
  apiKey: 'test-key',
  model: 'bge-reranker-v2-m3',
  timeoutMs: 5000,
  maxDocumentChars: 6000,
  maxCandidates: 50,
  maxClientBatchSize: 64,
};

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

describe('BgeRerankerProvider.rerank', () => {
  it('TEST 17 — candidates are reranked, returning one score per document in input order', async () => {
    mockFetchOnce(() => jsonResponse({ results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }] }));
    const provider = new BgeRerankerProvider(CONFIG);
    const result = await provider.rerank('where is auth handled', ['doc about payments', 'doc about login']);
    assert.deepEqual(result.scores, [0.2, 0.9]);
    assert.equal(result.model, 'bge-reranker-v2-m3');
  });

  it('TEST 18 — scores reflect actual relevance ordering (higher score = more relevant)', async () => {
    mockFetchOnce(() => jsonResponse({ results: [{ index: 0, relevance_score: 0.05 }, { index: 1, relevance_score: 0.99 }, { index: 2, relevance_score: 0.4 }] }));
    const provider = new BgeRerankerProvider(CONFIG);
    const result = await provider.rerank('query', ['irrelevant', 'highly relevant', 'somewhat relevant']);
    const ranked = result.scores.map((score, i) => ({ i, score })).sort((a, b) => b.score - a.score);
    assert.deepEqual(ranked.map((r) => r.i), [1, 2, 0]);
  });

  it('accepts a bare array response shape as an alternative to {results: [...]}', async () => {
    mockFetchOnce(() => jsonResponse([{ index: 0, score: 0.3 }, { index: 1, score: 0.7 }]));
    const provider = new BgeRerankerProvider(CONFIG);
    const result = await provider.rerank('query', ['a', 'b']);
    assert.deepEqual(result.scores, [0.3, 0.7]);
  });

  it('TEST 24 (Phase 6) — sends the real verified request shape: {query, texts}, never {documents} or a model field', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] });
    });
    const provider = new BgeRerankerProvider(CONFIG);
    await provider.rerank('my query', ['doc a']);
    const body = capturedBody as { query: string; texts: string[]; documents?: unknown; model?: unknown };
    assert.equal(body.query, 'my query');
    assert.deepEqual(body.texts, ['doc a']);
    assert.equal(body.documents, undefined);
    assert.equal(body.model, undefined);
  });

  it('Phase 6 — a document longer than maxDocumentChars is truncated before being sent, so one oversized chunk cannot 413 the whole batch', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return jsonResponse([{ index: 0, score: 0.1 }, { index: 1, score: 0.2 }]);
    });
    const provider = new BgeRerankerProvider({ ...CONFIG, maxDocumentChars: 10 });
    await provider.rerank('query', ['a'.repeat(50), 'short']);
    const body = capturedBody as { texts: string[] };
    assert.equal(body.texts[0].length, 10);
    assert.equal(body.texts[1], 'short');
  });

  it('empty documents is handled without making any request', async () => {
    let called = false;
    mockFetchOnce(() => {
      called = true;
      return jsonResponse({ results: [] });
    });
    const provider = new BgeRerankerProvider(CONFIG);
    const result = await provider.rerank('query', []);
    assert.equal(called, false);
    assert.deepEqual(result.scores, []);
  });

  it('TEST 21 — a request that exceeds the configured timeout throws RerankerTimeoutError', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))) as typeof fetch;
    const provider = new BgeRerankerProvider({ ...CONFIG, timeoutMs: 20 });
    await assert.rejects(() => provider.rerank('query', ['doc']), (error: unknown) => {
      assert.ok(error instanceof RerankerTimeoutError);
      assert.equal(error.timeoutMs, 20);
      return true;
    });
  });

  it('TEST 22 — an externally aborted signal throws RerankerCancelledError, not a timeout', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))) as typeof fetch;
    const provider = new BgeRerankerProvider(CONFIG);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider.rerank('query', ['doc'], controller.signal), (error: unknown) => {
      assert.ok(error instanceof RerankerCancelledError);
      return true;
    });
  });

  it('TEST 20 — provider unavailable (network error) throws RerankerUnavailableError', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['doc']), (error: unknown) => {
      assert.ok(error instanceof RerankerUnavailableError);
      return true;
    });
  });

  it('provider unavailable (non-2xx HTTP response) throws RerankerUnavailableError with the status code', async () => {
    mockFetchOnce(() => jsonResponse({ error: 'model not found' }, 404));
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['doc']), (error: unknown) => {
      assert.ok(error instanceof RerankerUnavailableError);
      assert.equal(error.statusCode, 404);
      return true;
    });
  });

  it('TEST 23 — a malformed response (missing a results array) throws RerankerInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ notResults: [] }));
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['doc']), (error: unknown) => {
      assert.ok(error instanceof RerankerInvalidResponseError);
      return true;
    });
  });

  it('a malformed response missing a score for one document throws RerankerInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ results: [{ index: 0, relevance_score: 0.5 }] })); // missing index 1
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['a', 'b']), (error: unknown) => {
      assert.ok(error instanceof RerankerInvalidResponseError);
      return true;
    });
  });

  it('a response entry with an out-of-range index throws RerankerInvalidResponseError', async () => {
    mockFetchOnce(() => jsonResponse({ results: [{ index: 5, relevance_score: 0.5 }] }));
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['a']), (error: unknown) => {
      assert.ok(error instanceof RerankerInvalidResponseError);
      return true;
    });
  });

  it('a non-JSON response body throws RerankerInvalidResponseError', async () => {
    mockFetchOnce(() => new Response('not json', { status: 200 }));
    const provider = new BgeRerankerProvider(CONFIG);
    await assert.rejects(() => provider.rerank('query', ['doc']), (error: unknown) => {
      assert.ok(error instanceof RerankerInvalidResponseError);
      return true;
    });
  });
});

describe('BgeRerankerProvider.isAvailable', () => {
  it('reports reachable: true when the server responds ok to a health check', async () => {
    mockFetchOnce(() => new Response('{}', { status: 200 }));
    const provider = new BgeRerankerProvider(CONFIG);
    const status = await provider.isAvailable();
    assert.equal(status.reachable, true);
  });

  it('reports reachable: false when the server cannot be reached at all', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const provider = new BgeRerankerProvider(CONFIG);
    const status = await provider.isAvailable();
    assert.equal(status.reachable, false);
  });
});

describe('resolveRerankerConfig', () => {
  beforeEach(() => {
    delete process.env.AI_RERANKER_MODEL;
    delete process.env.AI_RERANKER_BASE_URL;
    delete process.env.AI_RERANKER_TIMEOUT_MS;
    delete process.env.AI_RERANKER_MAX_DOCUMENT_CHARS;
    delete process.env.AI_RERANKER_MAX_CANDIDATES;
    delete process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE;
  });

  it('Phase 6 — defaults maxDocumentChars to a safe, conservative value', () => {
    const config = resolveRerankerConfig();
    assert.equal(config.maxDocumentChars, 6_000);
  });

  it('Phase 6 — honors AI_RERANKER_MAX_DOCUMENT_CHARS from the environment', () => {
    process.env.AI_RERANKER_MAX_DOCUMENT_CHARS = '4000';
    const config = resolveRerankerConfig();
    assert.equal(config.maxDocumentChars, 4000);
  });

  it('Phase 6 — falls back to the safe default for an invalid AI_RERANKER_MAX_DOCUMENT_CHARS', () => {
    process.env.AI_RERANKER_MAX_DOCUMENT_CHARS = 'not-a-number';
    const config = resolveRerankerConfig();
    assert.equal(config.maxDocumentChars, 6_000);
  });

  it('defaults the model to bge-reranker-v2-m3, never a different model', () => {
    const config = resolveRerankerConfig();
    assert.equal(config.model, 'bge-reranker-v2-m3');
  });

  it('honors AI_RERANKER_MODEL, AI_RERANKER_BASE_URL, and AI_RERANKER_TIMEOUT_MS from the environment', () => {
    process.env.AI_RERANKER_MODEL = 'custom-reranker';
    process.env.AI_RERANKER_BASE_URL = 'http://custom-host:9000';
    process.env.AI_RERANKER_TIMEOUT_MS = '9000';
    const config = resolveRerankerConfig();
    assert.equal(config.model, 'custom-reranker');
    assert.equal(config.baseUrl, 'http://custom-host:9000');
    assert.equal(config.timeoutMs, 9000);
  });

  it('falls back to a safe default timeout for an invalid AI_RERANKER_TIMEOUT_MS', () => {
    process.env.AI_RERANKER_TIMEOUT_MS = 'not-a-number';
    const config = resolveRerankerConfig();
    assert.equal(config.timeoutMs, 15_000);
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_RERANKER_MODEL = 'from-env';
    const config = resolveRerankerConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
  });

  it('never reuses the embedding or chat model timeout variables', () => {
    process.env.AI_MODEL_TIMEOUT_MS = '999999';
    process.env.AI_EMBED_TIMEOUT_MS = '888888';
    const config = resolveRerankerConfig();
    assert.notEqual(config.timeoutMs, 999999);
    assert.notEqual(config.timeoutMs, 888888);
    delete process.env.AI_MODEL_TIMEOUT_MS;
    delete process.env.AI_EMBED_TIMEOUT_MS;
  });
});

describe('resolveRerankerConfig — candidate/batch-size safety validation (Phase 7)', () => {
  beforeEach(() => {
    delete process.env.AI_RERANKER_MAX_CANDIDATES;
    delete process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE;
  });

  // A. Defaults
  it('defaults maxCandidates to 50 (unchanged from Phase 5/6)', () => {
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
  });

  it('defaults maxClientBatchSize to 64 (matching docker-compose.yml\'s TEI --max-client-batch-size)', () => {
    const config = resolveRerankerConfig();
    assert.equal(config.maxClientBatchSize, 64);
  });

  // B. Valid configuration
  it('accepts candidates = 50, batch size = 64 (the real deployed configuration)', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '50';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
    assert.equal(config.maxClientBatchSize, 64);
  });

  it('accepts candidates = 64, batch size = 64 (exactly equal is not a violation)', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '64';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 64);
  });

  // C. Invalid configuration — must throw, never clamp, never silently degrade
  it('rejects candidates = 65, batch size = 64', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '65';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(() => resolveRerankerConfig(), RerankerConfigurationError);
  });

  it('rejects candidates = 100, batch size = 64', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '100';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(() => resolveRerankerConfig(), RerankerConfigurationError);
  });

  it('never clamps maxCandidates down to maxClientBatchSize instead of throwing', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '100';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(() => resolveRerankerConfig());
    // The throw above proves resolveRerankerConfig() never returns a
    // "helpfully" clamped config for this input — there is no successful
    // return value to inspect here, which is the point.
  });

  // D. Invalid numeric configuration for the two new fields — same
  // permissive per-field fallback as every other field in this function
  // (missing/zero/negative/non-numeric silently falls back to that field's
  // own default), never a relational throw caused by a garbled single value.
  it('falls back to the default maxCandidates for zero', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '0';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
  });

  it('falls back to the default maxCandidates for a negative number', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '-5';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
  });

  it('falls back to the default maxCandidates for a non-numeric value', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = 'not-a-number';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
  });

  it('falls back to the default maxClientBatchSize for zero', () => {
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '0';
    const config = resolveRerankerConfig();
    assert.equal(config.maxClientBatchSize, 64);
  });

  it('falls back to the default maxClientBatchSize for a negative number', () => {
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '-1';
    const config = resolveRerankerConfig();
    assert.equal(config.maxClientBatchSize, 64);
  });

  it('falls back to the default maxClientBatchSize for a non-numeric value', () => {
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = 'garbage';
    const config = resolveRerankerConfig();
    assert.equal(config.maxClientBatchSize, 64);
  });

  it('tolerates surrounding whitespace the same way every other numeric env var in this file already does', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = ' 50 ';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = ' 64 ';
    const config = resolveRerankerConfig();
    assert.equal(config.maxCandidates, 50);
    assert.equal(config.maxClientBatchSize, 64);
  });

  // E. Error quality
  it('the error message includes both configured values', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '100';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(
      () => resolveRerankerConfig(),
      (error: unknown) => {
        assert.ok(error instanceof RerankerConfigurationError);
        assert.match(error.message, /100/);
        assert.match(error.message, /64/);
        assert.match(error.message, /AI_RERANKER_MAX_CANDIDATES/);
        assert.match(error.message, /AI_RERANKER_MAX_CLIENT_BATCH_SIZE/);
        return true;
      },
    );
  });

  it('the error message explains how to fix the problem', () => {
    process.env.AI_RERANKER_MAX_CANDIDATES = '100';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(
      () => resolveRerankerConfig(),
      (error: unknown) => {
        assert.ok(error instanceof RerankerConfigurationError);
        assert.match(error.message, /increase/i);
        assert.match(error.message, /reduce/i);
        return true;
      },
    );
  });

  it('does not make any network request while validating configuration', () => {
    let fetchCalled = false;
    globalThis.fetch = (() => { fetchCalled = true; return Promise.reject(new Error('should not be called')); }) as typeof fetch;
    process.env.AI_RERANKER_MAX_CANDIDATES = '100';
    process.env.AI_RERANKER_MAX_CLIENT_BATCH_SIZE = '64';
    assert.throws(() => resolveRerankerConfig());
    assert.equal(fetchCalled, false);
    globalThis.fetch = originalFetch;
  });

  it('explicit overrides participate in the same validation as environment variables', () => {
    assert.throws(
      () => resolveRerankerConfig({ maxCandidates: 100, maxClientBatchSize: 64 }),
      RerankerConfigurationError,
    );
  });
});
