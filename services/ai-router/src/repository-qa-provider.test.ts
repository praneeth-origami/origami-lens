import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RepositoryQaCancelledError,
  RepositoryQaInvalidResponseError,
  RepositoryQaTimeoutError,
  RepositoryQaUnavailableError,
  answerRepositoryQuestion,
  resolveRepositoryQaConfig,
} from './repository-qa-provider.js';

const CONFIG = { baseUrl: 'http://fake-ai-server', apiKey: 'test-key', model: 'test-text-model', timeoutMs: 5000, maxTokens: 1024 };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchArgs = Parameters<typeof fetch>;
function mockFetchOnce(handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response> | Response) {
  globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => Promise.resolve(handler(input, init))) as typeof fetch;
}

function chatResponse(content: unknown): Response {
  const body = { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('answerRepositoryQuestion', () => {
  it('parses a well-formed answer', async () => {
    mockFetchOnce(() => chatResponse({ answer: 'The health score is calculated in calculateHealthScore.' }));
    const result = await answerRepositoryQuestion(CONFIG, { query: 'How is the health score calculated?', contextText: 'File: a.ts\n\nCode:\nfunction calculateHealthScore() {}' });
    assert.equal(result.answer, 'The health score is calculated in calculateHealthScore.');
    assert.equal(result.model, 'test-text-model');
  });

  it('accepts an answer wrapped in a markdown fence', async () => {
    mockFetchOnce(() => chatResponse('```json\n' + JSON.stringify({ answer: 'x' }) + '\n```'));
    const result = await answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' });
    assert.equal(result.answer, 'x');
  });

  it('rejects a response missing the answer field', async () => {
    mockFetchOnce(() => chatResponse({ notAnswer: 'x' }));
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }),
      RepositoryQaInvalidResponseError,
    );
  });

  it('rejects an empty-string answer', async () => {
    mockFetchOnce(() => chatResponse({ answer: '   ' }));
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }),
      RepositoryQaInvalidResponseError,
    );
  });

  it('rejects non-JSON model output', async () => {
    mockFetchOnce(() => chatResponse('not json at all'));
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }),
      RepositoryQaInvalidResponseError,
    );
  });

  it('throws RepositoryQaTimeoutError on a timed-out request', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(
      () => answerRepositoryQuestion({ ...CONFIG, timeoutMs: 10 }, { query: 'q', contextText: 'c' }),
      RepositoryQaTimeoutError,
    );
  });

  it('throws RepositoryQaCancelledError when the caller aborts', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }, controller.signal),
      RepositoryQaCancelledError,
    );
  });

  it('throws RepositoryQaUnavailableError on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }),
      RepositoryQaUnavailableError,
    );
  });

  it('throws RepositoryQaUnavailableError on a non-2xx HTTP response', async () => {
    mockFetchOnce(() => new Response('server error', { status: 500 }));
    await assert.rejects(
      () => answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'c' }),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryQaUnavailableError);
        assert.equal(error.statusCode, 500);
        return true;
      },
    );
  });

  it('sends the query and context text in the user message, and the anti-injection instruction in the system message', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ answer: 'x' });
    });
    await answerRepositoryQuestion(CONFIG, { query: 'How does auth work?', contextText: 'File: auth.ts\n\nCode:\nfunction login() {}' });
    const body = capturedBody as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'test-text-model');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /DATA ONLY/);
    assert.match(body.messages[0].content, /ignore previous instructions/i);
    assert.equal(body.messages[1].role, 'user');
    assert.match(body.messages[1].content, /How does auth work\?/);
    assert.match(body.messages[1].content, /function login/);
  });

  it('never lets contextText appear in the system message', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ answer: 'x' });
    });
    await answerRepositoryQuestion(CONFIG, { query: 'q', contextText: 'UNIQUE_MARKER_TOKEN_xyz123' });
    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    assert.ok(!body.messages[0].content.includes('UNIQUE_MARKER_TOKEN_xyz123'));
    assert.ok(body.messages[1].content.includes('UNIQUE_MARKER_TOKEN_xyz123'));
  });
});

describe('resolveRepositoryQaConfig', () => {
  beforeEach(() => {
    delete process.env.VLLM_BASE_URL;
    delete process.env.AI_TEXT_MODEL;
    delete process.env.AI_REPOSITORY_QA_TIMEOUT_MS;
    delete process.env.AI_REPOSITORY_QA_MAX_TOKENS;
  });

  it('defaults timeoutMs to 60000', () => {
    const config = resolveRepositoryQaConfig();
    assert.equal(config.timeoutMs, 60_000);
  });

  it('honors AI_REPOSITORY_QA_TIMEOUT_MS from the environment', () => {
    process.env.AI_REPOSITORY_QA_TIMEOUT_MS = '12345';
    const config = resolveRepositoryQaConfig();
    assert.equal(config.timeoutMs, 12345);
  });

  it('never reuses AI_MODEL_TIMEOUT_MS, AI_CODE_GENERATION_TIMEOUT_MS, or AI_ISSUE_ANALYSIS_TIMEOUT_MS', () => {
    process.env.AI_MODEL_TIMEOUT_MS = '777';
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '888';
    process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS = '999';
    const config = resolveRepositoryQaConfig();
    assert.notEqual(config.timeoutMs, 777);
    assert.notEqual(config.timeoutMs, 888);
    assert.notEqual(config.timeoutMs, 999);
    delete process.env.AI_MODEL_TIMEOUT_MS;
    delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
    delete process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS;
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_TEXT_MODEL = 'from-env';
    const config = resolveRepositoryQaConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
  });
});
