import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FindingFixCancelledError,
  FindingFixInvalidResponseError,
  FindingFixTimeoutError,
  FindingFixUnavailableError,
  proposeFindingFix,
  resolveFindingFixConfig,
} from './repository-finding-fix-provider.js';

const CONFIG = { baseUrl: 'http://fake-ai-server', apiKey: 'test-key', model: 'test-text-model', timeoutMs: 5000, maxTokens: 2048 };

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

/** Simulates a real vLLM/Ollama chat-completion response that stopped mid-generation because it hit its output-token budget — `finish_reason: "length"` and a `content` string with no closing quote/brace, exactly the shape observed in the real production incident this file's Bugfix tests cover. */
function truncatedChatResponse(rawContent: string): Response {
  const body = { choices: [{ message: { content: rawContent }, finish_reason: 'length' }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('proposeFindingFix', () => {
  it('parses a well-formed PROPOSED response', async () => {
    mockFetchOnce(() => chatResponse({
      status: 'PROPOSED', summary: 'Increase contrast', reasoning: 'The evidence shows a low-contrast background.',
      changes: [{ filePath: 'apps/web/src/styles/dashboard.css', language: 'css', hunks: [{ startLine: 120, endLine: 125, oldText: 'background: #ffffff;', newText: 'background: #1f2937;' }] }],
    }));
    const result = await proposeFindingFix(CONFIG, { contextText: 'FINDING...\n\nREPOSITORY CONTEXT...' });
    assert.equal(result.status, 'PROPOSED');
    assert.equal(result.summary, 'Increase contrast');
    assert.equal(result.changes.length, 1);
    assert.equal(result.model, 'test-text-model');
  });

  it('parses a well-formed INSUFFICIENT_EVIDENCE response with empty changes', async () => {
    mockFetchOnce(() => chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'No matching code found.', reasoning: 'x', changes: [] }));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
    assert.deepEqual(result.changes, []);
  });

  it('accepts a response wrapped in a markdown fence', async () => {
    mockFetchOnce(() => chatResponse('```json\n' + JSON.stringify({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] }) + '\n```'));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  });

  it('rejects a response with an unrecognized status value', async () => {
    mockFetchOnce(() => chatResponse({ status: 'MAYBE', summary: 'S', reasoning: 'R', changes: [] }));
    await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
  });

  it('rejects a response missing required fields', async () => {
    mockFetchOnce(() => chatResponse({ status: 'PROPOSED' }));
    await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
  });

  it('rejects non-JSON model output', async () => {
    mockFetchOnce(() => chatResponse('not json at all'));
    await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
  });

  it('Bugfix: a real live response had a complete, valid JSON object followed by trailing prose — that prose is stripped, not treated as a parse error', async () => {
    const validJson = JSON.stringify({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    mockFetchOnce(() => chatResponse(validJson + '\n\nLet me know if you need anything else!'));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  });

  it('Bugfix: trailing prose that itself contains a closing brace (defeats a naive lastIndexOf("}") extraction) is still stripped correctly', async () => {
    const validJson = JSON.stringify({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    mockFetchOnce(() => chatResponse(validJson + '\n\nNote: this uses the {default} export.'));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  });

  it('a brace character inside an "oldText"/"newText" string value is never mistaken for the end of the JSON object', async () => {
    mockFetchOnce(() => chatResponse({
      status: 'PROPOSED', summary: 'S', reasoning: 'R',
      changes: [{ filePath: 'a.ts', language: 'typescript', hunks: [{ startLine: 1, endLine: 1, oldText: 'const x = {}', newText: 'const x = { y: 1 }' }] }],
    }));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'PROPOSED');
    assert.equal(result.changes[0]!.hunks![0]!.newText, 'const x = { y: 1 }');
  });

  describe('Bugfix: a real truncated response (finish_reason "length") is classified as an invalid response, not provider-unavailable', () => {
    it('a response truncated mid-string (unterminated string) is rejected as FindingFixInvalidResponseError, carrying the real content length', async () => {
      const truncated = '{"status":"PROPOSED","summary":"Fix the thing","reasoning":"Because","changes":[{"filePath":"a.ts","language":"typescript","hunks":[{"startLine":1,"endLine":1,"oldText":"const x = 1;","newText":"const x = 2; // this string never closes';
      mockFetchOnce(() => truncatedChatResponse(truncated));
      await assert.rejects(
        () => proposeFindingFix(CONFIG, { contextText: 'c' }),
        (error: unknown) => {
          assert.ok(error instanceof FindingFixInvalidResponseError);
          assert.ok(error.message.includes(`length=${truncated.length}`));
          assert.ok(/unterminated string/i.test(error.message) || /unexpected end/i.test(error.message));
          return true;
        },
      );
    });

    it('a response truncated mid-object (missing closing braces) is also rejected as FindingFixInvalidResponseError', async () => {
      const truncated = '{"status":"PROPOSED","summary":"S","reasoning":"R","changes":[{"filePath":"a.ts"';
      mockFetchOnce(() => truncatedChatResponse(truncated));
      await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
    });

    it('does not log the response content, prompt, or context text — only safe metadata — when a truncated response is rejected', async () => {
      const truncated = '{"status":"PROPOSED","summary":"SECRET_SUMMARY_MARKER","reasoning":"R","changes":[{"oldText":"SECRET_OLDTEXT_MARKER';
      mockFetchOnce(() => truncatedChatResponse(truncated));
      const originalConsoleError = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'UNIQUE_CONTEXT_MARKER' }), FindingFixInvalidResponseError);
      } finally {
        console.error = originalConsoleError;
      }
      const combined = logged.join('\n');
      assert.ok(!combined.includes('SECRET_SUMMARY_MARKER'));
      assert.ok(!combined.includes('SECRET_OLDTEXT_MARKER'));
      assert.ok(!combined.includes('UNIQUE_CONTEXT_MARKER'));
      // The diagnostic log line itself must still be present and structured.
      assert.ok(logged.some((line) => line.includes('repository_finding_fix_llm_response_invalid')));
      assert.ok(logged.some((line) => line.includes('"finishReason":"length"')));
      assert.ok(logged.some((line) => line.includes('"likelyTruncated":true')));
    });

    it('never logs the API key/Authorization header', async () => {
      const truncated = '{"status":"PROPOSED"';
      mockFetchOnce(() => truncatedChatResponse(truncated));
      const originalConsoleError = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await assert.rejects(() => proposeFindingFix({ ...CONFIG, apiKey: 'SUPER_SECRET_KEY' }, { contextText: 'c' }), FindingFixInvalidResponseError);
      } finally {
        console.error = originalConsoleError;
      }
      assert.ok(!logged.join('\n').includes('SUPER_SECRET_KEY'));
    });
  });

  describe('Bugfix 2: a real malformed-but-COMPLETE response (finish_reason "stop") is diagnosed as an invalid response, never mistaken for truncation', () => {
    /**
     * Reproduces the exact real-world failure discovered live against
     * repository 5de7ebf8-ddb4-475f-bc4c-1d84b0c09edd / finding
     * 078d9e57-2b9a-43de-8265-428bb38be484: the model completed generation
     * normally (finish_reason "stop", well under the 4096-token budget) but
     * wrote a bare, unescaped `"` inside the "reasoning" string value while
     * describing an HTML/JSX attribute (`role="main"`), which is invalid
     * JSON despite Ollama's `format: "json"` mode being active. Confirmed
     * live: increasing max_tokens does not affect this failure mode at all.
     */
    function stopFinishResponse(rawContent: string): Response {
      const body = { choices: [{ message: { content: rawContent }, finish_reason: 'stop' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    it('a complete response containing a bare unescaped quote inside a string value is rejected as FindingFixInvalidResponseError', async () => {
      // The exact real trigger shape: a bare " inside "reasoning", after `role=`.
      const malformed = '{"status":"PROPOSED","summary":"Added landmark role.","reasoning":"Landmarks help screen readers. By adding the `role="main"` attribute to the container, assistive technology can identify it.","changes":[]}';
      mockFetchOnce(() => stopFinishResponse(malformed));
      await assert.rejects(
        () => proposeFindingFix(CONFIG, { contextText: 'c' }),
        (error: unknown) => {
          assert.ok(error instanceof FindingFixInvalidResponseError);
          assert.ok(error.message.includes(`length=${malformed.length}`));
          return true;
        },
      );
    });

    it('the diagnostic log correctly reports finishReason "stop" and likelyTruncated false for this failure — never conflating it with a token-budget issue', async () => {
      const malformed = '{"status":"PROPOSED","summary":"S","reasoning":"the `attr="v"` here","changes":[]}';
      mockFetchOnce(() => stopFinishResponse(malformed));
      const originalConsoleError = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
      } finally {
        console.error = originalConsoleError;
      }
      const combined = logged.join('\n');
      assert.ok(combined.includes('"finishReason":"stop"'));
      assert.ok(combined.includes('"likelyTruncated":false'));
      assert.ok(combined.includes('"maxTokens":2048'));
      assert.ok(combined.includes(`"contextLength":`));
    });

    it('does not log the malformed response content itself for this failure mode either', async () => {
      const malformed = '{"status":"PROPOSED","summary":"SECRET_MARKER_2","reasoning":"the `attr="v"` here","changes":[]}';
      mockFetchOnce(() => stopFinishResponse(malformed));
      const originalConsoleError = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
      try {
        await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixInvalidResponseError);
      } finally {
        console.error = originalConsoleError;
      }
      assert.ok(!logged.join('\n').includes('SECRET_MARKER_2'));
    });
  });

  it('Bugfix: the request body sends max_tokens exactly equal to config.maxTokens (verifies the configured value is actually what reaches Ollama)', async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix({ ...CONFIG, maxTokens: 4096 }, { contextText: 'c' });
    assert.equal(capturedBody.max_tokens, 4096);
  });

  it('Bugfix 2: the request body sends temperature 0, not the previous 0.2 — live A/B evidence showed this measurably reduces malformed structured output', async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(capturedBody.temperature, 0);
  });

  it('the system prompt forbids markdown/backtick-quoted attribute syntax in summary/reasoning and reinforces string-escaping discipline', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix(CONFIG, { contextText: 'c' });
    const systemContent = capturedBody!.messages[0].content;
    assert.match(systemContent, /plain prose only/i);
    assert.match(systemContent, /role="main"/);
    assert.match(systemContent, /must be escaped/i);
  });

  it('a well-formed response that completed normally (finish_reason "stop") parses successfully', async () => {
    const body = {
      choices: [{
        message: { content: JSON.stringify({ status: 'PROPOSED', summary: 'S', reasoning: 'R', changes: [] }) },
        finish_reason: 'stop',
      }],
    };
    mockFetchOnce(() => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.equal(result.status, 'PROPOSED');
  });

  it('Bugfix 2: requests Ollama schema-constrained JSON (format: <json-schema-object>), not the generic format:"json" boolean mode, when the base URL is an Ollama server', async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix({ ...CONFIG, baseUrl: 'http://localhost:11434/v1' }, { contextText: 'c' });
    assert.equal(typeof capturedBody.format, 'object');
    assert.equal(capturedBody.response_format, undefined);
    const schema = capturedBody.format as { type: string; required: string[]; properties: Record<string, unknown> };
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.required, ['status', 'summary', 'reasoning', 'changes']);
    // The schema must constrain the exact nested shape (changes[].hunks[])
    // that was proven live to be where qwen2.5:7b/Ollama's generic JSON
    // mode drops a closing bracket — a schema that is only shallow
    // (top-level fields only) would not have fixed the real bug.
    const changesSchema = schema.properties.changes as { type: string; items: { properties: { hunks: { type: string; items: { required: string[] } } } } };
    assert.equal(changesSchema.type, 'array');
    assert.equal(changesSchema.items.properties.hunks.type, 'array');
    assert.deepEqual(changesSchema.items.properties.hunks.items.required, ['startLine', 'endLine', 'oldText', 'newText']);
  });

  it('requests OpenAI-style JSON mode (response_format: json_object) for a non-Ollama base URL', async () => {
    let capturedBody: Record<string, unknown> = {};
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix({ ...CONFIG, baseUrl: 'http://fake-vllm-server:8000/v1' }, { contextText: 'c' });
    assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
    assert.equal(capturedBody.format, undefined);
  });

  it('the system prompt tells the model to keep the response small and bounded (files/hunks/snippet size)', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } | undefined;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.match(capturedBody!.messages[0].content, /at most 3 files/i);
    assert.match(capturedBody!.messages[0].content, /at most 5 hunks per file/i);
  });

  it('tolerates a missing/malformed changes array by defaulting to empty rather than throwing', async () => {
    mockFetchOnce(() => chatResponse({ status: 'PROPOSED', summary: 'S', reasoning: 'R' }));
    const result = await proposeFindingFix(CONFIG, { contextText: 'c' });
    assert.deepEqual(result.changes, []);
  });

  it('throws FindingFixTimeoutError on a timed-out request', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(() => proposeFindingFix({ ...CONFIG, timeoutMs: 10 }, { contextText: 'c' }), FindingFixTimeoutError);
  });

  it('throws FindingFixCancelledError when the caller aborts', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }, controller.signal), FindingFixCancelledError);
  });

  it('throws FindingFixUnavailableError on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assert.rejects(() => proposeFindingFix(CONFIG, { contextText: 'c' }), FindingFixUnavailableError);
  });

  it('throws FindingFixUnavailableError on a non-2xx HTTP response', async () => {
    mockFetchOnce(() => new Response('server error', { status: 500 }));
    await assert.rejects(
      () => proposeFindingFix(CONFIG, { contextText: 'c' }),
      (error: unknown) => {
        assert.ok(error instanceof FindingFixUnavailableError);
        assert.equal(error.statusCode, 500);
        return true;
      },
    );
  });

  it('sends the context text and instruction in the user message, and the anti-injection + minimal-change rules in the system message', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix(CONFIG, { contextText: 'FINDING: contrast issue', instruction: 'Do not change the layout.' });
    const body = capturedBody as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'test-text-model');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /DATA ONLY/);
    assert.match(body.messages[0].content, /ignore previous instructions/i);
    assert.match(body.messages[0].content, /smallest reasonable change/i);
    assert.match(body.messages[0].content, /can never override/i);
    assert.equal(body.messages[1].role, 'user');
    assert.match(body.messages[1].content, /FINDING: contrast issue/);
    assert.match(body.messages[1].content, /Do not change the layout\./);
  });

  it('never lets contextText or instruction appear in the system message', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ status: 'INSUFFICIENT_EVIDENCE', summary: 'S', reasoning: 'R', changes: [] });
    });
    await proposeFindingFix(CONFIG, { contextText: 'UNIQUE_CONTEXT_MARKER_1', instruction: 'UNIQUE_INSTRUCTION_MARKER_2' });
    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    assert.ok(!body.messages[0].content.includes('UNIQUE_CONTEXT_MARKER_1'));
    assert.ok(!body.messages[0].content.includes('UNIQUE_INSTRUCTION_MARKER_2'));
    assert.ok(body.messages[1].content.includes('UNIQUE_CONTEXT_MARKER_1'));
    assert.ok(body.messages[1].content.includes('UNIQUE_INSTRUCTION_MARKER_2'));
  });
});

describe('resolveFindingFixConfig', () => {
  beforeEach(() => {
    delete process.env.VLLM_BASE_URL;
    delete process.env.AI_TEXT_MODEL;
    delete process.env.AI_REPOSITORY_FIX_TIMEOUT_MS;
  });

  it('defaults timeoutMs to 90000', () => {
    const config = resolveFindingFixConfig();
    assert.equal(config.timeoutMs, 90_000);
  });

  it('Bugfix: defaults maxTokens to 4096, not the previous 2048 that was observed truncating a real response', () => {
    delete process.env.AI_REPOSITORY_FIX_MAX_TOKENS;
    const config = resolveFindingFixConfig();
    assert.equal(config.maxTokens, 4096);
  });

  it('honors AI_REPOSITORY_FIX_MAX_TOKENS from the environment', () => {
    process.env.AI_REPOSITORY_FIX_MAX_TOKENS = '8192';
    const config = resolveFindingFixConfig();
    assert.equal(config.maxTokens, 8192);
    delete process.env.AI_REPOSITORY_FIX_MAX_TOKENS;
  });

  it('honors AI_REPOSITORY_FIX_TIMEOUT_MS from the environment', () => {
    process.env.AI_REPOSITORY_FIX_TIMEOUT_MS = '54321';
    const config = resolveFindingFixConfig();
    assert.equal(config.timeoutMs, 54321);
  });

  it('never reuses AI_MODEL_TIMEOUT_MS, AI_CODE_GENERATION_TIMEOUT_MS, AI_ISSUE_ANALYSIS_TIMEOUT_MS, or AI_REPOSITORY_QA_TIMEOUT_MS', () => {
    process.env.AI_MODEL_TIMEOUT_MS = '111';
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '222';
    process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS = '333';
    process.env.AI_REPOSITORY_QA_TIMEOUT_MS = '444';
    const config = resolveFindingFixConfig();
    assert.notEqual(config.timeoutMs, 111);
    assert.notEqual(config.timeoutMs, 222);
    assert.notEqual(config.timeoutMs, 333);
    assert.notEqual(config.timeoutMs, 444);
    delete process.env.AI_MODEL_TIMEOUT_MS;
    delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
    delete process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS;
    delete process.env.AI_REPOSITORY_QA_TIMEOUT_MS;
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_TEXT_MODEL = 'from-env';
    const config = resolveFindingFixConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
  });
});
