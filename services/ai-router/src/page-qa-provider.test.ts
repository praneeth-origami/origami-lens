import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PageQaCancelledError,
  PageQaInvalidResponseError,
  PageQaTimeoutError,
  PageQaUnavailableError,
  answerPageQuestion,
  resolvePageQaConfig,
} from './page-qa-provider.js';

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

describe('answerPageQuestion', () => {
  it('parses a well-formed answer', async () => {
    mockFetchOnce(() => chatResponse({ answer: 'The largest contentful paint is 4200ms, well above the recommended 2500ms threshold.' }));
    const result = await answerPageQuestion(CONFIG, { question: 'Why is this page slow?', contextText: 'Performance metrics:\n  LCP: 4200ms' });
    assert.equal(result.model, 'test-text-model');
    assert.match(result.answer, /4200ms/);
  });

  it('accepts a response wrapped in a markdown fence', async () => {
    mockFetchOnce(() => chatResponse('```json\n' + JSON.stringify({ answer: 'Grounded answer.' }) + '\n```'));
    const result = await answerPageQuestion(CONFIG, { question: 'What is broken?', contextText: 'c' });
    assert.equal(result.answer, 'Grounded answer.');
  });

  it('rejects non-JSON model output', async () => {
    mockFetchOnce(() => chatResponse('not json at all'));
    await assert.rejects(() => answerPageQuestion(CONFIG, { question: 'q', contextText: 'c' }), PageQaInvalidResponseError);
  });

  it('rejects a response missing a non-empty "answer" field', async () => {
    mockFetchOnce(() => chatResponse({ notAnswer: 'x' }));
    await assert.rejects(() => answerPageQuestion(CONFIG, { question: 'q', contextText: 'c' }), PageQaInvalidResponseError);
  });

  it('never logs the response content, question, or context text — only safe metadata — when a response is rejected', async () => {
    mockFetchOnce(() => chatResponse('SECRET_MARKER not json'));
    const originalConsoleError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await assert.rejects(() => answerPageQuestion(CONFIG, { question: 'UNIQUE_QUESTION_MARKER', contextText: 'UNIQUE_CONTEXT_MARKER' }), PageQaInvalidResponseError);
    } finally {
      console.error = originalConsoleError;
    }
    assert.ok(!logged.join('\n').includes('SECRET_MARKER'));
    assert.ok(!logged.join('\n').includes('UNIQUE_QUESTION_MARKER'));
    assert.ok(!logged.join('\n').includes('UNIQUE_CONTEXT_MARKER'));
  });

  it('throws PageQaTimeoutError on a timed-out request', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(() => answerPageQuestion({ ...CONFIG, timeoutMs: 10 }, { question: 'q', contextText: 'c' }), PageQaTimeoutError);
  });

  it('throws PageQaCancelledError when the caller aborts', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => answerPageQuestion(CONFIG, { question: 'q', contextText: 'c' }, controller.signal), PageQaCancelledError);
  });

  it('throws PageQaUnavailableError on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assert.rejects(() => answerPageQuestion(CONFIG, { question: 'q', contextText: 'c' }), PageQaUnavailableError);
  });

  it('throws PageQaUnavailableError on a non-2xx HTTP response', async () => {
    mockFetchOnce(() => new Response('server error', { status: 500 }));
    await assert.rejects(
      () => answerPageQuestion(CONFIG, { question: 'q', contextText: 'c' }),
      (error: unknown) => {
        assert.ok(error instanceof PageQaUnavailableError);
        assert.equal(error.statusCode, 500);
        return true;
      },
    );
  });

  it('sends the question and context text in the user message, and the anti-injection + grounding rules in the system message', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = ((_input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(chatResponse({ answer: 'A' }));
    }) as typeof fetch;
    await answerPageQuestion(CONFIG, { question: 'Why is this page slow?', contextText: 'PERF_CONTEXT_MARKER' });
    assert.match(capturedBody!.messages[0].content, /DATA ONLY/);
    assert.match(capturedBody!.messages[0].content, /ignore previous instructions/i);
    assert.match(capturedBody!.messages[0].content, /Never invent metrics/i);
    assert.equal(capturedBody!.messages[1].role, 'user');
    assert.match(capturedBody!.messages[1].content, /Why is this page slow\?/);
    assert.match(capturedBody!.messages[1].content, /PERF_CONTEXT_MARKER/);
  });

  it('never lets contextText leak into the system message', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = ((_input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(chatResponse({ answer: 'A' }));
    }) as typeof fetch;
    await answerPageQuestion(CONFIG, { question: 'q', contextText: 'UNIQUE_CONTEXT_MARKER_1' });
    assert.ok(!capturedBody!.messages[0].content.includes('UNIQUE_CONTEXT_MARKER_1'));
    assert.ok(capturedBody!.messages[1].content.includes('UNIQUE_CONTEXT_MARKER_1'));
  });

  it('the request body sends temperature 0.2 and the configured max_tokens', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((_input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(chatResponse({ answer: 'A' }));
    }) as typeof fetch;
    await answerPageQuestion({ ...CONFIG, maxTokens: 2048 }, { question: 'q', contextText: 'c' });
    assert.equal(capturedBody.temperature, 0.2);
    assert.equal(capturedBody.max_tokens, 2048);
  });
});

describe('resolvePageQaConfig', () => {
  it('defaults timeoutMs to 60000 and maxTokens to 1024', () => {
    delete process.env.AI_PAGE_QA_TIMEOUT_MS;
    delete process.env.AI_PAGE_QA_MAX_TOKENS;
    const config = resolvePageQaConfig();
    assert.equal(config.timeoutMs, 60_000);
    assert.equal(config.maxTokens, 1024);
  });

  it('honors AI_PAGE_QA_TIMEOUT_MS/AI_PAGE_QA_MAX_TOKENS from the environment', () => {
    process.env.AI_PAGE_QA_TIMEOUT_MS = '54321';
    process.env.AI_PAGE_QA_MAX_TOKENS = '2048';
    const config = resolvePageQaConfig();
    assert.equal(config.timeoutMs, 54321);
    assert.equal(config.maxTokens, 2048);
    delete process.env.AI_PAGE_QA_TIMEOUT_MS;
    delete process.env.AI_PAGE_QA_MAX_TOKENS;
  });

  it('never reuses AI_REPOSITORY_QA_TIMEOUT_MS or other tasks\' timeout env vars', () => {
    process.env.AI_REPOSITORY_QA_TIMEOUT_MS = '111';
    const config = resolvePageQaConfig();
    assert.notEqual(config.timeoutMs, 111);
    delete process.env.AI_REPOSITORY_QA_TIMEOUT_MS;
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_TEXT_MODEL = 'from-env';
    const config = resolvePageQaConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
    delete process.env.AI_TEXT_MODEL;
  });
});
