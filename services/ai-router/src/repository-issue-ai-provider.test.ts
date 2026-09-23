import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RepositoryAiCancelledError,
  RepositoryAiInvalidResponseError,
  RepositoryAiTimeoutError,
  RepositoryAiUnavailableError,
  analyzeRepositoryIssue,
  proposeRepositoryFix,
  resolveRepositoryAiConfig,
} from './repository-issue-ai-provider.js';

const CONFIG = {
  baseUrl: 'http://fake-ai-server',
  apiKey: 'test-key',
  model: 'test-text-model',
  analysisTimeoutMs: 5000,
  proposalTimeoutMs: 5000,
  analysisMaxTokens: 1536,
  proposalMaxTokens: 3072,
};

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

const SAMPLE_EVIDENCE = [{ filePath: 'src/a.ts', language: 'typescript', symbol: 'foo', symbolType: 'function', startLine: 1, endLine: 5, content: 'function foo() {}' }];

describe('analyzeRepositoryIssue', () => {
  it('parses a well-formed analysis response', async () => {
    mockFetchOnce(() => chatResponse({
      summary: 'S', rootCause: 'R', confidence: 'HIGH', affectedFiles: ['src/a.ts'], affectedSymbols: ['foo'],
      reasoning: 'because', recommendedFix: 'do X', validationPlan: 'test Y',
    }));
    const result = await analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE });
    assert.equal(result.summary, 'S');
    assert.equal(result.confidence, 'HIGH');
    assert.deepEqual(result.affectedFiles, ['src/a.ts']);
    assert.equal(result.model, 'test-text-model');
  });

  it('accepts a response wrapped in a markdown fence', async () => {
    mockFetchOnce(() => chatResponse('```json\n' + JSON.stringify({ summary: 'S', rootCause: 'R', confidence: 'LOW', reasoning: 'x' }) + '\n```'));
    const result = await analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE });
    assert.equal(result.confidence, 'LOW');
  });

  it('rejects a response missing required fields', async () => {
    mockFetchOnce(() => chatResponse({ summary: 'S' }));
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      RepositoryAiInvalidResponseError,
    );
  });

  it('rejects an invalid confidence value rather than accepting an unrecognized string', async () => {
    mockFetchOnce(() => chatResponse({ summary: 'S', rootCause: 'R', confidence: 'VERY_SURE', reasoning: 'x' }));
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      RepositoryAiInvalidResponseError,
    );
  });

  it('rejects non-JSON model output', async () => {
    mockFetchOnce(() => chatResponse('not json at all'));
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      RepositoryAiInvalidResponseError,
    );
  });

  it('throws RepositoryAiTimeoutError on a timed-out request', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('timed out', 'TimeoutError'))) as typeof fetch;
    await assert.rejects(
      () => analyzeRepositoryIssue({ ...CONFIG, analysisTimeoutMs: 10 }, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      RepositoryAiTimeoutError,
    );
  });

  it('throws RepositoryAiCancelledError when the caller aborts', async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException('aborted', 'AbortError'))) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }, controller.signal),
      RepositoryAiCancelledError,
    );
  });

  it('throws RepositoryAiUnavailableError on a network error', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      RepositoryAiUnavailableError,
    );
  });

  it('throws RepositoryAiUnavailableError on a non-2xx HTTP response', async () => {
    mockFetchOnce(() => new Response('server error', { status: 500 }));
    await assert.rejects(
      () => analyzeRepositoryIssue(CONFIG, { title: 't', description: 'd', evidence: SAMPLE_EVIDENCE }),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryAiUnavailableError);
        assert.equal(error.statusCode, 500);
        return true;
      },
    );
  });

  it('sends the evidence and issue fields in the request body', async () => {
    let capturedBody: unknown;
    mockFetchOnce((_input, init) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatResponse({ summary: 'S', rootCause: 'R', confidence: 'MEDIUM', reasoning: 'x' });
    });
    await analyzeRepositoryIssue(CONFIG, { title: 'My Title', description: 'My Desc', evidence: SAMPLE_EVIDENCE });
    const body = capturedBody as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'test-text-model');
    assert.ok(body.messages[1].content.includes('My Title'));
    assert.ok(body.messages[1].content.includes('foo'));
  });
});

describe('proposeRepositoryFix', () => {
  const ANALYSIS = { model: 'm', summary: 'S', rootCause: 'R', confidence: 'HIGH' as const, affectedFiles: [], affectedSymbols: [], reasoning: 'x', recommendedFix: 'fix it', validationPlan: 'test it' };

  it('parses a well-formed fix proposal response', async () => {
    mockFetchOnce(() => chatResponse({
      summary: 'Fix summary',
      files: [{ filePath: 'src/a.ts', changeType: 'MODIFIED', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new' }],
    }));
    const result = await proposeRepositoryFix(CONFIG, { title: 't', description: 'd', analysis: ANALYSIS, evidence: SAMPLE_EVIDENCE });
    assert.equal(result.summary, 'Fix summary');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].filePath, 'src/a.ts');
    assert.equal(result.files[0].changeType, 'MODIFIED');
  });

  it('defaults an invalid/missing changeType to MODIFIED rather than rejecting the whole proposal', async () => {
    mockFetchOnce(() => chatResponse({ summary: 'S', files: [{ filePath: 'src/a.ts', diff: 'diff text' }] }));
    const result = await proposeRepositoryFix(CONFIG, { title: 't', description: 'd', analysis: ANALYSIS, evidence: SAMPLE_EVIDENCE });
    assert.equal(result.files[0].changeType, 'MODIFIED');
  });

  it('rejects a response missing the files array', async () => {
    mockFetchOnce(() => chatResponse({ summary: 'S' }));
    await assert.rejects(
      () => proposeRepositoryFix(CONFIG, { title: 't', description: 'd', analysis: ANALYSIS, evidence: SAMPLE_EVIDENCE }),
      RepositoryAiInvalidResponseError,
    );
  });

  it('rejects a file entry missing filePath or diff', async () => {
    mockFetchOnce(() => chatResponse({ summary: 'S', files: [{ changeType: 'MODIFIED' }] }));
    await assert.rejects(
      () => proposeRepositoryFix(CONFIG, { title: 't', description: 'd', analysis: ANALYSIS, evidence: SAMPLE_EVIDENCE }),
      RepositoryAiInvalidResponseError,
    );
  });
});

describe('resolveRepositoryAiConfig', () => {
  beforeEach(() => {
    delete process.env.VLLM_BASE_URL;
    delete process.env.AI_TEXT_MODEL;
    delete process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS;
    delete process.env.AI_FIX_PROPOSAL_TIMEOUT_MS;
  });

  it('defaults analysisTimeoutMs to 60000 and proposalTimeoutMs to 90000', () => {
    const config = resolveRepositoryAiConfig();
    assert.equal(config.analysisTimeoutMs, 60_000);
    assert.equal(config.proposalTimeoutMs, 90_000);
  });

  it('honors AI_ISSUE_ANALYSIS_TIMEOUT_MS and AI_FIX_PROPOSAL_TIMEOUT_MS independently', () => {
    process.env.AI_ISSUE_ANALYSIS_TIMEOUT_MS = '11111';
    process.env.AI_FIX_PROPOSAL_TIMEOUT_MS = '22222';
    const config = resolveRepositoryAiConfig();
    assert.equal(config.analysisTimeoutMs, 11111);
    assert.equal(config.proposalTimeoutMs, 22222);
  });

  it('never reuses AI_MODEL_TIMEOUT_MS or AI_CODE_GENERATION_TIMEOUT_MS', () => {
    process.env.AI_MODEL_TIMEOUT_MS = '777';
    process.env.AI_CODE_GENERATION_TIMEOUT_MS = '888';
    const config = resolveRepositoryAiConfig();
    assert.notEqual(config.analysisTimeoutMs, 777);
    assert.notEqual(config.proposalTimeoutMs, 888);
    delete process.env.AI_MODEL_TIMEOUT_MS;
    delete process.env.AI_CODE_GENERATION_TIMEOUT_MS;
  });

  it('explicit overrides take precedence over environment variables', () => {
    process.env.AI_TEXT_MODEL = 'from-env';
    const config = resolveRepositoryAiConfig({ model: 'from-override' });
    assert.equal(config.model, 'from-override');
  });
});
