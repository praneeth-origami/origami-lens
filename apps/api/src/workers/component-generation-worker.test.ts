import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ComponentEvidence, ComponentGenerationJob, GeneratedComponentResult } from '@origami/contracts';

// These tests exercise cancelComponentJob() and the worker's own job
// lifecycle directly (no HTTP layer, no real AI Gateway) — the /cancel route
// itself is a thin wrapper already covered by manual verification. Every
// import that reaches env-sensitive modules (component-store's DATA_DIR,
// website-scan-worker's getRedisConnection) is deferred to a dynamic
// import() inside before(), after these env vars are pinned, so this file's
// module graph never touches the developer's real .origami-data directory
// or a real Redis instance regardless of what apps/api/.env contains.
let UnifiedComponentStore: typeof import('../unified-component-store.js').UnifiedComponentStore;
let worker: typeof import('./component-generation-worker.js');

function makeEvidence(): ComponentEvidence {
  return {
    sourceUrl: 'https://example.com/pricing',
    pageTitle: 'Pricing',
    capturedAt: new Date().toISOString(),
    boundingBox: { x: 0, y: 0, width: 320, height: 460, devicePixelRatio: 1, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 },
    screenshotBase64: 'ZmFrZS1zY3JlZW5zaG90',
    element: { tag: 'div', selector: 'div', attributes: {}, style: {}, boundingBox: { x: 0, y: 0, width: 320, height: 460 }, children: [] },
    ancestors: [],
    html: '<div></div>',
    cssVariables: {},
    assets: [],
    containsSensitiveFields: false,
  };
}

function makeResult(): GeneratedComponentResult {
  return { componentName: 'PricingCard', files: [{ path: 'PricingCard.jsx', content: 'export function PricingCard() { return null; }' }], dependencies: [], notes: [] };
}

/**
 * A generate() double that never resolves on its own — it hands its resolver
 * out to the test via `onCall`, so the test controls exactly when (and with
 * what outcome) the "AI Gateway call" finishes. This is what lets these
 * tests assert real ordering (e.g. "status was RUNNING before cancel was
 * requested", "a late success loses to an earlier cancel") without relying
 * on arbitrary sleep durations.
 */
class ManualGenerator {
  onCall: ((signal: AbortSignal | undefined, resolve: (o: unknown) => void) => void) | null = null;

  generate(_sourceUrl: string, _target: string, _evidence: ComponentEvidence, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve) => {
      this.onCall?.(signal, resolve);
    });
  }
}

function waitForCall(gen: ManualGenerator): Promise<{ signal: AbortSignal | undefined; resolve: (o: unknown) => void }> {
  return new Promise((resolve) => {
    gen.onCall = (signal, resolveOutcome) => resolve({ signal, resolve: resolveOutcome });
  });
}

describe('component-generation-worker cancellation', () => {
  let store: InstanceType<typeof UnifiedComponentStore>;
  let jobCounter = 0;

  before(async () => {
    process.env.REDIS_URL = ''; // force the in-memory setImmediate path, never a real Redis connection
    process.env.DATABASE_URL = ''; // force the legacy in-memory/file store, never a real Postgres connection
    process.env.SCAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-cancel-test-'));
    ({ UnifiedComponentStore } = await import('../unified-component-store.js'));
    worker = await import('./component-generation-worker.js');
  });

  function freshJobId(): string {
    jobCounter += 1;
    return `test-job-${jobCounter}`;
  }

  it('cancels a QUEUED job that no worker has picked up yet', async () => {
    store = new UnifiedComponentStore();
    const jobId = freshJobId();
    const queued: ComponentGenerationJob = {
      jobId, sourceUrl: 'https://example.com', target: 'REACT', status: 'QUEUED', aiAvailable: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.saveJob(queued);

    const result = await worker.cancelComponentJob(store, jobId);

    assert.equal(result?.status, 'CANCELLED');
    const persisted = await store.getJobAsync(jobId);
    assert.equal(persisted?.status, 'CANCELLED');
  });

  it('never resurrects a job that was cancelled while still QUEUED, even if a worker tries to start it afterward', async () => {
    store = new UnifiedComponentStore();
    const gen = new ManualGenerator();
    const jobId = freshJobId();
    store.saveJob({
      jobId, sourceUrl: 'https://example.com', target: 'REACT', status: 'QUEUED', aiAvailable: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await worker.cancelComponentJob(store, jobId);
    // Simulate a delayed pickup: a worker only now gets around to running the
    // job the setImmediate/BullMQ handoff already queued before cancellation.
    worker.enqueueComponentJob(store, gen as unknown as import('../component-generator.js').ComponentGenerator, {
      jobId, sourceUrl: 'https://example.com', target: 'REACT', evidence: makeEvidence(),
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const persisted = await store.getJobAsync(jobId);
    assert.equal(persisted?.status, 'CANCELLED', 'a late-starting worker must not overwrite an already-cancelled job with RUNNING');
  });

  it('aborts a RUNNING job\'s in-flight AI call and a late-arriving "success" from that call does not override the cancellation', async () => {
    store = new UnifiedComponentStore();
    const gen = new ManualGenerator();
    const jobId = freshJobId();

    worker.enqueueComponentJob(store, gen as unknown as import('../component-generator.js').ComponentGenerator, {
      jobId, sourceUrl: 'https://example.com', target: 'REACT', evidence: makeEvidence(),
    });

    const { signal, resolve } = await waitForCall(gen);
    const runningSnapshot = await store.getJobAsync(jobId);
    assert.equal(runningSnapshot?.status, 'RUNNING', 'job must be RUNNING by the time the AI Gateway call starts');
    assert.equal(signal?.aborted, false);

    const cancelResult = await worker.cancelComponentJob(store, jobId);
    assert.equal(cancelResult?.status, 'CANCELLED');
    assert.equal(signal?.aborted, true, 'cancelling a RUNNING job must abort the signal passed into generate()');

    // The in-flight call finally "succeeds" after the cancel was requested —
    // this must not resurrect the job as COMPLETED.
    resolve({ status: 'COMPLETED', aiAvailable: true, componentName: 'PricingCard', result: makeResult() });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const final = await store.getJobAsync(jobId);
    assert.equal(final?.status, 'CANCELLED', 'a late success must not override a cancellation that was already requested');
    assert.equal(final?.result, undefined, 'no component result may be committed for a cancelled job');
  });

  it('leaves a COMPLETED job untouched when a cancel is requested against it', async () => {
    store = new UnifiedComponentStore();
    const jobId = freshJobId();
    const completed: ComponentGenerationJob = {
      jobId, sourceUrl: 'https://example.com', target: 'REACT', status: 'COMPLETED', aiAvailable: true,
      result: makeResult(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.saveJob(completed);

    const result = await worker.cancelComponentJob(store, jobId);

    assert.equal(result?.status, 'COMPLETED', 'cancelling an already-finished job must be a no-op, not overwrite its result');
    assert.deepEqual(result?.result, makeResult());
  });

  it('leaves a FAILED job untouched when a cancel is requested against it', async () => {
    store = new UnifiedComponentStore();
    const jobId = freshJobId();
    store.saveJob({
      jobId, sourceUrl: 'https://example.com', target: 'REACT', status: 'FAILED', aiAvailable: false,
      error: 'Code generation is temporarily unavailable.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const result = await worker.cancelComponentJob(store, jobId);

    assert.equal(result?.status, 'FAILED');
    assert.equal(result?.error, 'Code generation is temporarily unavailable.');
  });

  it('is idempotent — cancelling the same RUNNING job twice in a row does not throw and stays CANCELLED', async () => {
    store = new UnifiedComponentStore();
    const gen = new ManualGenerator();
    const jobId = freshJobId();
    worker.enqueueComponentJob(store, gen as unknown as import('../component-generator.js').ComponentGenerator, {
      jobId, sourceUrl: 'https://example.com', target: 'REACT', evidence: makeEvidence(),
    });
    const { signal, resolve } = await waitForCall(gen);
    // Mirrors the real ComponentGenerator: once its outbound request is
    // actually aborted, generate() itself settles rather than hanging
    // forever — this is what lets processJob's finally{} run and release
    // this job's timeout timer, so this test doesn't leak a live handle.
    signal?.addEventListener('abort', () => resolve({ status: 'CANCELLED', aiAvailable: false, error: 'Generation cancelled by user.' }));

    const first = await worker.cancelComponentJob(store, jobId);
    const second = await worker.cancelComponentJob(store, jobId);
    await new Promise((r) => setImmediate(r));

    assert.equal(first?.status, 'CANCELLED');
    assert.equal(second?.status, 'CANCELLED');
  });

  it('returns undefined for a job id that does not exist, rather than throwing', async () => {
    store = new UnifiedComponentStore();
    const result = await worker.cancelComponentJob(store, 'no-such-job');
    assert.equal(result, undefined);
  });

  it('the job-level timeout marks a stuck RUNNING job TIMED_OUT (not CANCELLED or FAILED) and aborts its in-flight call, distinguishing a timeout from a user-initiated stop', async () => {
    const originalTimeout = process.env.COMPONENT_GENERATION_TIMEOUT_MS;
    process.env.COMPONENT_GENERATION_TIMEOUT_MS = '50';
    try {
      const timeoutWorker = await import('./component-generation-worker.js?variant=short-timeout');
      store = new UnifiedComponentStore();
      const gen = new ManualGenerator();
      const jobId = freshJobId();

      timeoutWorker.enqueueComponentJob(store, gen as unknown as import('../component-generator.js').ComponentGenerator, {
        jobId, sourceUrl: 'https://example.com', target: 'REACT', evidence: makeEvidence(),
      });
      const { signal, resolve } = await waitForCall(gen);
      // Real generate() calls always settle once their request is aborted —
      // reproduce that here so this job's timeout-triggered abort lets
      // finalize() run instead of hanging on an unresolved promise forever.
      signal?.addEventListener('abort', () => resolve({ status: 'CANCELLED', aiAvailable: false, error: 'Generation cancelled by user.' }));

      await new Promise((r) => setTimeout(r, 150));

      assert.equal(signal?.aborted, true, 'the overall generation timeout must abort the in-flight call');
      const final = await store.getJobAsync(jobId);
      assert.equal(final?.status, 'TIMED_OUT');
      assert.equal(final?.errorCategory, 'MODEL_TIMEOUT');
      assert.match(final?.error ?? '', /timed out/i);
      assert.notEqual(final?.status, 'CANCELLED', 'a timeout is not a user cancellation and must be reported distinctly');
      assert.notEqual(final?.status, 'FAILED', 'a timeout is not a generic failure and must be reported as its own terminal state');
    } finally {
      process.env.COMPONENT_GENERATION_TIMEOUT_MS = originalTimeout;
    }
  });

  it('canCancelJob rejects a cancel request from a different owner but allows it when owners match or are unset (best-effort check — no real auth exists yet)', () => {
    assert.equal(worker.canCancelJob('user-a', 'user-b'), false);
    assert.equal(worker.canCancelJob('user-a', 'user-a'), true);
    assert.equal(worker.canCancelJob(undefined, 'user-b'), true);
    assert.equal(worker.canCancelJob('user-a', undefined), true);
    assert.equal(worker.canCancelJob(undefined, undefined), true);
  });
});
