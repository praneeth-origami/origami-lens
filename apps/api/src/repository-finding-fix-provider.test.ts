import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FindingFixProviderError, HttpFindingFixProvider } from './repository-finding-fix-provider.js';

/**
 * Regression coverage for a real production bug: this HTTP client used to
 * collapse EVERY non-2xx, non-504 response from the AI Router's
 * /propose-finding-fix route into LLM_PROVIDER_UNAVAILABLE — including a
 * real, reachable LLM that returned a malformed/truncated JSON response
 * (HTTP 502, errorCategory "LLM_INVALID_RESPONSE"). That misreported "the
 * model answered but the response was broken" as "the provider could not
 * be reached at all". These tests exercise every errorCategory the AI
 * Router's route can actually send (services/ai-router/src/index.ts) and
 * confirm each maps to a DISTINCT, correct RepositoryFixProposalErrorCode.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

function validResult() {
  return { model: 'test-model', status: 'PROPOSED', summary: 'S', reasoning: 'R', changes: [] };
}

describe('HttpFindingFixProvider — error classification', () => {
  it('a 502 with errorCategory LLM_INVALID_RESPONSE maps to LLM_INVALID_RESPONSE, never LLM_PROVIDER_UNAVAILABLE (the reported bug)', async () => {
    mockFetchOnce(502, { error: 'Finding fix-proposal response was not valid JSON (length=8097): Unterminated string in JSON at position 7797 (line 1 column 7798)', errorCategory: 'LLM_INVALID_RESPONSE' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => {
        assert.ok(error instanceof FindingFixProviderError);
        assert.equal(error.category, 'LLM_INVALID_RESPONSE');
        assert.ok(error.message.includes('Unterminated string'));
        return true;
      },
    );
  });

  it('a 504 with errorCategory LLM_TIMEOUT maps to LLM_TIMEOUT', async () => {
    mockFetchOnce(504, { error: 'Finding fix-proposal request timed out after 90000ms', errorCategory: 'LLM_TIMEOUT' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_TIMEOUT'); return true; },
    );
  });

  it('a 503 with errorCategory LLM_PROVIDER_UNAVAILABLE maps to LLM_PROVIDER_UNAVAILABLE', async () => {
    mockFetchOnce(503, { error: 'Finding fix-proposal provider unreachable', errorCategory: 'LLM_PROVIDER_UNAVAILABLE' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('a 499 with errorCategory PROPOSAL_CANCELLED is never reported as LLM_PROVIDER_UNAVAILABLE', async () => {
    mockFetchOnce(499, { error: 'Finding fix-proposal request cancelled by caller', errorCategory: 'PROPOSAL_CANCELLED' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.notEqual(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('a response with no errorCategory (older/different AI Router build) falls back to the status-code heuristic — 504 still maps to LLM_TIMEOUT', async () => {
    mockFetchOnce(504, { error: 'timed out' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_TIMEOUT'); return true; },
    );
  });

  it('a response with no errorCategory and a non-504 status falls back to LLM_PROVIDER_UNAVAILABLE (backward compatible default)', async () => {
    mockFetchOnce(500, { error: 'server exploded' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('an unrecognized errorCategory string falls back to the status-code heuristic rather than throwing', async () => {
    mockFetchOnce(502, { error: 'something new', errorCategory: 'SOME_FUTURE_CATEGORY' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('a genuine network failure (fetch rejects) still maps to LLM_PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('a real timeout (AbortSignal.timeout fires) maps to LLM_TIMEOUT', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router', timeoutMs: 10 });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.equal(error.category, 'LLM_TIMEOUT'); return true; },
    );
  });

  it('an already-aborted caller signal is never reported as LLM_PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    await assert.rejects(
      () => provider.proposeFix({ contextText: 'c' }, controller.signal),
      (error: unknown) => { assert.ok(error instanceof FindingFixProviderError); assert.notEqual(error.category, 'LLM_PROVIDER_UNAVAILABLE'); return true; },
    );
  });

  it('a valid 200 response still parses successfully (no regression in the success path)', async () => {
    mockFetchOnce(200, validResult());
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router' });
    const result = await provider.proposeFix({ contextText: 'c' });
    assert.equal(result.status, 'PROPOSED');
  });

  it('never leaks the AI Router base URL or any header into the thrown error message', async () => {
    mockFetchOnce(502, { error: 'Finding fix-proposal response was not valid JSON (length=42): Unexpected end of JSON input', errorCategory: 'LLM_INVALID_RESPONSE' });
    const provider = new HttpFindingFixProvider({ baseUrl: 'http://fake-ai-router-internal.local:3102' });
    try {
      await provider.proposeFix({ contextText: 'c' });
      assert.fail('expected rejection');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('fake-ai-router-internal.local'));
    }
  });
});
