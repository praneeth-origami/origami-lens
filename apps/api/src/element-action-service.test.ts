import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ComponentEvidence, RepositoryEmbeddingJob } from '@origami/contracts';
import { ElementActionError, answerElementAction, type ElementActionDeps } from './element-action-service.js';
import { ElementQaProviderError, type ElementQaProvider } from './element-qa-provider.js';
import type { AskProviderDeps, RepositoryAskStores } from './repository-ai-service.js';
import { EmbeddingProviderError, type EmbeddingProvider } from './repository-embedding-provider.js';
import type { RerankerProvider } from './repository-reranker-provider.js';
import type { RepositoryQaProvider } from './repository-qa-provider.js';
import { RepositorySearchRepository, type VectorSearchCandidate } from './db/repository-search-repository.js';
import type { UnifiedRepositoryEmbeddingStore } from './unified-repository-embedding-store.js';

const DIMENSIONS = 4;
const COMMIT_SHA = 'a'.repeat(40);
const INDEX_JOB_ID = randomUUID();

class FakeEmbeddingProvider implements EmbeddingProvider {
  model = 'fake-bge-m3';
  dimensions = DIMENSIONS;
  failWith: EmbeddingProviderError | null = null;
  async embedBatch(texts: string[]) {
    if (this.failWith) throw this.failWith;
    return { model: this.model, dimensions: this.dimensions, vectors: texts.map(() => [0.1, 0.2, 0.3, 0.4]) };
  }
}

class FakeRerankerProvider implements RerankerProvider {
  model = 'fake-reranker';
  async rerank(_query: string, documents: string[]) {
    return { model: this.model, scores: documents.map((_, i) => i) };
  }
}

function makeCandidate(overrides: Partial<VectorSearchCandidate> = {}): VectorSearchCandidate {
  return {
    chunkId: randomUUID(), filePath: 'apps/web/src/components/ThemeToggle.tsx', language: 'typescript',
    symbol: 'ThemeToggle', symbolType: 'function', parentSymbol: null, startLine: 1, endLine: 20,
    isExported: true, content: 'export function ThemeToggle() { return <button className="theme-option active" />; }',
    vectorDistance: 0.1, ...overrides,
  };
}

function fakeStores(overrides: { embeddingJob?: RepositoryEmbeddingJob | null; candidates?: VectorSearchCandidate[] } = {}): RepositoryAskStores {
  const embeddingJob: RepositoryEmbeddingJob | undefined = overrides.embeddingJob === null ? undefined : overrides.embeddingJob ?? {
    jobId: randomUUID(), repositoryId: 'repo-1', indexJobId: INDEX_JOB_ID, commitSha: COMMIT_SHA,
    status: 'COMPLETED', model: 'fake-bge-m3', dimensions: DIMENSIONS, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const candidates = overrides.candidates ?? [makeCandidate()];

  const stubSearchRepo = Object.assign(Object.create(RepositorySearchRepository.prototype), {
    isEnabled: () => true,
    searchByVector: async () => candidates,
  }) as RepositorySearchRepository;

  const embeddingStore = { getLatestForRepositoryAsync: async () => embeddingJob, getEmbeddingsForCommitLegacy: () => [] } as unknown as UnifiedRepositoryEmbeddingStore;
  const indexStore = {
    getChunksForJobAsync: async () => [],
    getLatestForCommitAsync: async () => (embeddingJob ? { jobId: INDEX_JOB_ID, repositoryId: 'repo-1', cloneJobId: 'x', commitSha: COMMIT_SHA, status: 'COMPLETED', indexerVersion: '1', createdAt: 'x', updatedAt: 'x' } : undefined),
  } as unknown as RepositoryAskStores['indexStore'];

  return { embeddingStore, indexStore, searchRepository: stubSearchRepo };
}

function makeEvidence(overrides: Partial<ComponentEvidence> = {}): ComponentEvidence {
  return {
    sourceUrl: 'https://example.com/settings',
    pageTitle: 'Settings',
    capturedAt: new Date().toISOString(),
    boundingBox: { x: 0, y: 0, width: 100, height: 40, devicePixelRatio: 1, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720 },
    screenshotBase64: 'ZmFrZQ==',
    element: { tag: 'button', selector: 'button.theme-option.active', classList: ['theme-option', 'active'], attributes: {}, style: {}, boundingBox: { x: 0, y: 0, width: 100, height: 40 }, children: [] },
    ancestors: [],
    html: '<button class="theme-option active"></button>',
    cssVariables: {},
    assets: [],
    containsSensitiveFields: false,
    ...overrides,
  };
}

function stubProvider(answer: string | Error, capture?: { action?: string; contextText?: string; instruction?: string }): ElementQaProvider {
  return {
    model: 'stub-model',
    async answer(request) {
      if (capture) Object.assign(capture, request);
      if (answer instanceof Error) throw answer;
      return { model: 'stub-model', answer };
    },
  };
}

function browserOnlyDeps(answer: string | Error, capture?: { contextText?: string }): ElementActionDeps {
  return { qaProvider: stubProvider(answer, capture) };
}

describe('answerElementAction — browser-only path (no repositoryId)', () => {
  it('rejects invalid evidence before ever calling the provider', async () => {
    let called = false;
    const provider: ElementQaProvider = { model: 'x', async answer() { called = true; return { model: 'x', answer: 'x' }; } };
    await assert.rejects(
      () => answerElementAction({} as ComponentEvidence, 'explain', undefined, undefined, { qaProvider: provider }),
      (error: unknown) => { assert.ok(error instanceof ElementActionError); assert.equal(error.code, 'ACTION_FAILED'); return true; },
    );
    assert.equal(called, false);
  });

  it('rejects evidence containing a blocked sensitive field without calling the provider', async () => {
    let called = false;
    const provider: ElementQaProvider = { model: 'x', async answer() { called = true; return { model: 'x', answer: 'x' }; } };
    const evidence = makeEvidence({
      element: { tag: 'input', selector: 'input#password', attributes: { type: 'password', name: 'password' }, style: {}, boundingBox: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
    });
    await assert.rejects(
      () => answerElementAction(evidence, 'explain', undefined, undefined, { qaProvider: provider }),
      (error: unknown) => { assert.ok(error instanceof ElementActionError); assert.equal(error.code, 'EVIDENCE_BLOCKED'); return true; },
    );
    assert.equal(called, false);
  });

  it('grounds the answer in the scrubbed element evidence and returns groundedInRepository: false', async () => {
    const capture: { contextText?: string } = {};
    const result = await answerElementAction(makeEvidence(), 'explain', undefined, undefined, browserOnlyDeps('This is a theme toggle button.', capture));
    assert.equal(result.action, 'explain');
    assert.equal(result.answer, 'This is a theme toggle button.');
    assert.equal(result.groundedInRepository, false);
    assert.equal(result.model, 'stub-model');
    assert.match(capture.contextText!, /button\.theme-option\.active/);
  });

  it('maps an ElementQaProviderError onto the matching ElementActionError code', async () => {
    await assert.rejects(
      () => answerElementAction(makeEvidence(), 'improve', undefined, undefined, browserOnlyDeps(new ElementQaProviderError('timed out', 'LLM_TIMEOUT'))),
      (error: unknown) => { assert.ok(error instanceof ElementActionError); assert.equal(error.code, 'LLM_TIMEOUT'); return true; },
    );
  });
});

describe('answerElementAction — repository-grounded path (real answerRepositoryQuestion, real search/rerank pipeline)', () => {
  function repoDeps(overrides: { qa?: RepositoryQaProvider; stores?: RepositoryAskStores; providerDeps?: Partial<AskProviderDeps> } = {}) {
    return {
      repository: { id: 'repo-1', status: 'READY_FOR_SEARCH', organizationId: 'org-1' },
      stores: overrides.stores ?? fakeStores(),
      ownerId: 'org-1',
      providerDeps: {
        embeddingProvider: overrides.providerDeps?.embeddingProvider ?? new FakeEmbeddingProvider(),
        rerankerProvider: overrides.providerDeps?.rerankerProvider ?? new FakeRerankerProvider(),
        qaProvider: overrides.qa ?? { model: 'repo-model', async answer() { return { model: 'repo-model', answer: 'The button is defined in ThemeToggle.tsx; add an aria-label to fix the missing accessible name.' }; } },
      },
    };
  }

  it('grounds "fix" in the real repository search/rerank/Q&A pipeline, never calling the browser-only provider', async () => {
    let browserOnlyCalled = false;
    const deps: ElementActionDeps = { qaProvider: { model: 'x', async answer() { browserOnlyCalled = true; return { model: 'x', answer: 'x' }; } } };

    const result = await answerElementAction(makeEvidence(), 'fix', undefined, 'repo-1', deps, repoDeps());

    assert.equal(result.groundedInRepository, true);
    assert.match(result.answer, /ThemeToggle\.tsx/);
    assert.equal(result.model, 'repo-model');
    assert.equal(browserOnlyCalled, false);
  });

  it('falls back to the browser-only path when the repository does not exist/is not owned/is not ready (never fails the whole action)', async () => {
    const capture: { contextText?: string } = {};
    const deps = browserOnlyDeps('No repository was available, so here is general browser-only guidance.', capture);

    const result = await answerElementAction(makeEvidence(), 'fix', undefined, 'repo-1', deps, {
      repository: undefined, // triggers SearchError REPOSITORY_NOT_FOUND -> AskError -> falls back
      stores: fakeStores(),
      ownerId: 'org-1',
      providerDeps: { embeddingProvider: new FakeEmbeddingProvider(), rerankerProvider: new FakeRerankerProvider(), qaProvider: {} as RepositoryQaProvider },
    });

    assert.equal(result.groundedInRepository, false);
    assert.equal(result.answer, 'No repository was available, so here is general browser-only guidance.');
  });

  it('does NOT fall back for a real service failure (embedding provider unavailable) — that surfaces as a real ElementActionError, never silently degraded', async () => {
    const embedding = new FakeEmbeddingProvider();
    embedding.failWith = new EmbeddingProviderError('embedding service down', 'EMBEDDING_PROVIDER_UNAVAILABLE');
    let browserOnlyCalled = false;
    const deps: ElementActionDeps = { qaProvider: { model: 'x', async answer() { browserOnlyCalled = true; return { model: 'x', answer: 'x' }; } } };

    await assert.rejects(
      () => answerElementAction(makeEvidence(), 'fix', undefined, 'repo-1', deps, repoDeps({ providerDeps: { embeddingProvider: embedding } })),
      (error: unknown) => { assert.ok(error instanceof ElementActionError); assert.equal(error.code, 'ACTION_FAILED'); return true; },
    );
    assert.equal(browserOnlyCalled, false);
  });
});
