import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ElementQaCancelledError,
  ElementQaInvalidResponseError,
  ElementQaTimeoutError,
  ElementQaUnavailableError,
  answerElementQuestion,
  resolveElementQaConfig,
} from './element-qa-provider.js';

const CONFIG = { baseUrl: 'http://fake-ai-server', apiKey: 'test-key', model: 'test-text-model', timeoutMs: 5000, maxTokens: 1024 };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

type FetchArgs = Parameters<typeof fetch>;
function mockFetchOnce(handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response> | Response) {
  globalThis.fetch = ((input: FetchArgs[0], init?: FetchArgs[1]) => Promise.resolve(handler(input, init))) as typeof fetch;
}

function chatResponse(content: unknown): Response {
  const body = { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('answerElementQuestion', () => {
  it('parses a well-formed answer for "explain"', async () => {
    mockFetchOnce(() => chatResponse({ answer: 'This is a primary call-to-action button styled with the theme accent color.' }));
    const result = await answerElementQuestion(CONFIG, { action: 'explain', contextText: 'Selected element: button.cta' });
    assert.equal(result.model, 'test-text-model');
    assert.match(result.answer, /call-to-action/);
  });

  it('rejects non-JSON model output', async () => {
    mockFetchOnce(() => chatResponse('not json at all'));
    await assert.rejects(() => answerElementQuestion(CONFIG, { action: 'explain', contextText: 'c' }), ElementQaInvalidResponseError);
  });

  it('throws ElementQaTimeoutError on a timed-out request', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(() => answerElementQuestion({ ...CONFIG, timeoutMs: 10 }, { action: 'fix', contextText: 'c' }), ElementQaTimeoutError);
  });

  it('throws ElementQaCancelledError when the caller aborts', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => answerElementQuestion(CONFIG, { action: 'improve', contextText: 'c' }, controller.signal), ElementQaCancelledError);
  });

  it('throws ElementQaUnavailableError on a non-2xx HTTP response', async () => {
    mockFetchOnce(() => new Response('server error', { status: 500 }));
    await assert.rejects(
      () => answerElementQuestion(CONFIG, { action: 'make_responsive', contextText: 'c' }),
      (error: unknown) => { assert.ok(error instanceof ElementQaUnavailableError); assert.equal(error.statusCode, 500); return true; },
    );
  });

  it('frames the prompt differently per action, and includes the anti-injection + grounding rules in the system message', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = ((_input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(chatResponse({ answer: 'A' }));
    }) as typeof fetch;

    await answerElementQuestion(CONFIG, { action: 'make_responsive', contextText: 'ELEMENT_CONTEXT_MARKER' });
    assert.match(capturedBody!.messages[1].content, /MOBILE\/RESPONSIVE/);
    assert.match(capturedBody!.messages[1].content, /ELEMENT_CONTEXT_MARKER/);
    assert.match(capturedBody!.messages[0].content, /DATA ONLY/);
    assert.match(capturedBody!.messages[0].content, /ignore previous instructions/i);
  });

  it('includes the optional instruction in the user message and never lets it appear in the system message', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    globalThis.fetch = ((_input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedBody = JSON.parse(init!.body as string);
      return Promise.resolve(chatResponse({ answer: 'A' }));
    }) as typeof fetch;

    await answerElementQuestion(CONFIG, { action: 'improve', contextText: 'c', instruction: 'UNIQUE_INSTRUCTION_MARKER' });
    assert.match(capturedBody!.messages[1].content, /UNIQUE_INSTRUCTION_MARKER/);
    assert.ok(!capturedBody!.messages[0].content.includes('UNIQUE_INSTRUCTION_MARKER'));
  });
});

describe('resolveElementQaConfig', () => {
  it('defaults timeoutMs to 60000 and maxTokens to 1024', () => {
    delete process.env.AI_ELEMENT_QA_TIMEOUT_MS;
    delete process.env.AI_ELEMENT_QA_MAX_TOKENS;
    const config = resolveElementQaConfig();
    assert.equal(config.timeoutMs, 60_000);
    assert.equal(config.maxTokens, 1024);
  });

  it('never reuses AI_PAGE_QA_TIMEOUT_MS or other tasks\' timeout env vars', () => {
    process.env.AI_PAGE_QA_TIMEOUT_MS = '111';
    const config = resolveElementQaConfig();
    assert.notEqual(config.timeoutMs, 111);
    delete process.env.AI_PAGE_QA_TIMEOUT_MS;
  });
});
