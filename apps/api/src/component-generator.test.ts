import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ComponentDomNode, ComponentEvidence } from '@origami/contracts';

function makeNode(partial: Partial<ComponentDomNode> = {}): ComponentDomNode {
  return {
    tag: 'div',
    selector: 'div.pricing-card',
    classList: ['pricing-card'],
    attributes: { class: 'pricing-card' },
    style: {},
    boundingBox: { x: 0, y: 0, width: 320, height: 460 },
    children: [
      {
        tag: 'button', selector: 'button', text: 'Buy now', attributes: {},
        style: {}, boundingBox: { x: 0, y: 400, width: 100, height: 40 }, children: [],
      },
    ],
    ...partial,
  };
}

function makeEvidence(overrides: Partial<ComponentEvidence> = {}): ComponentEvidence {
  return {
    sourceUrl: 'https://example.com/pricing',
    pageTitle: 'Pricing',
    capturedAt: new Date().toISOString(),
    boundingBox: { x: 0, y: 0, width: 320, height: 460, devicePixelRatio: 1, scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 800 },
    screenshotBase64: 'ZmFrZS1zY3JlZW5zaG90',
    element: makeNode(),
    ancestors: [],
    html: '<div class="pricing-card"><button>Buy now</button></div>',
    cssVariables: {},
    assets: [],
    containsSensitiveFields: false,
    ...overrides,
  };
}

interface StubState {
  server: http.Server;
  url: string;
  requests: Array<{ task: string; payload: unknown }>;
  mode: 'success' | 'unavailable';
  /** Overrides generate_component's `result` verbatim — for exercising parseFiles() against specific model-output shapes without needing a real model call. */
  customCodeResult?: Record<string, unknown>;
}

function startStubGateway(): Promise<StubState> {
  // `state` IS the object returned to the caller — tests mutate `stub.mode`
  // directly and the request handler below must observe that same mutation,
  // not a snapshot copy taken at server-start time.
  const state = { requests: [], mode: 'success' } as StubState;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      state.requests!.push({ task: parsed.task, payload: parsed.payload });

      if (state.mode === 'unavailable') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, task: parsed.task, model: 'deterministic-fallback', error: 'Code generation is temporarily unavailable.' }));
        return;
      }

      let result: Record<string, unknown>;
      if (parsed.task === 'screenshot_to_code') {
        result = { suggestedComponentName: 'PricingCard', summary: 'a card', sections: [], colors: [], typography: {}, layout: 'flex' };
      } else if (state.customCodeResult) {
        result = state.customCodeResult;
      } else {
        result = {
          componentName: 'PricingCard',
          files: [{ path: 'PricingCard.jsx', content: 'export function PricingCard() { return <div>Buy now sk-thisisnotarealkeyabcdefgh</div>; }' }],
          dependencies: [],
          notes: [],
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, task: parsed.task, model: 'stub-model', result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      state.server = server;
      state.url = `http://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

describe('ComponentGenerator', () => {
  let stub: StubState;
  let originalUrl: string | undefined;
  let ComponentGenerator: typeof import('./component-generator.js').ComponentGenerator;

  before(async () => {
    stub = await startStubGateway();
    originalUrl = process.env.AI_ROUTER_URL;
    process.env.AI_ROUTER_URL = stub.url;
    // Import after setting the env var — component-generator.ts reads it at module load time.
    ({ ComponentGenerator } = await import('./component-generator.js'));
  });

  after(async () => {
    process.env.AI_ROUTER_URL = originalUrl;
    await new Promise((r) => stub.server.close(() => r(undefined)));
  });

  it('completes successfully through both AI Gateway stages when the model server is healthy', async () => {
    stub.mode = 'success';
    stub.requests.length = 0;
    const generator = new ComponentGenerator();

    const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());

    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.aiAvailable, true);
    assert.equal(outcome.componentName, 'PricingCard');
    assert.equal(outcome.result?.files.length, 1);
    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[0].task, 'screenshot_to_code');
    assert.equal(stub.requests[1].task, 'generate_component');
  });

  it('scrubs secret-looking strings out of generated code before returning it', async () => {
    stub.mode = 'success';
    const generator = new ComponentGenerator();
    const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.ok(outcome.result);
    assert.ok(!outcome.result!.files[0].content.includes('sk-thisisnotarealkeyabcdefgh'));
    assert.ok(outcome.result!.files[0].content.includes('[REDACTED_CREDENTIAL]'));
  });

  it('runs real structural verification on the result', async () => {
    stub.mode = 'success';
    const generator = new ComponentGenerator();
    const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.ok(outcome.verification);
    assert.equal(outcome.verification!.passed, true);
  });

  it('fails honestly (never fabricates code) when the AI Gateway reports the model unavailable', async () => {
    stub.mode = 'unavailable';
    stub.requests.length = 0;
    const generator = new ComponentGenerator();

    const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());

    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.aiAvailable, false);
    assert.equal(outcome.error, 'Code generation is temporarily unavailable.');
    assert.equal(outcome.result, undefined);
    // Only stage 1 should have been attempted — stage 2 never runs after stage 1 fails.
    assert.equal(stub.requests.length, 1);
  });

  it('fails honestly (not a raw fetch error) when the AI Router process itself is unreachable, distinct from a reachable-but-model-unavailable failure', async () => {
    const badUrl = process.env.AI_ROUTER_URL;
    process.env.AI_ROUTER_URL = 'http://127.0.0.1:1';
    try {
      // Distinct module instance so it picks up the unreachable AI_ROUTER_URL
      // captured above, without disturbing the stub-pointed instance used by
      // every other test in this file.
      const { ComponentGenerator: FreshGenerator } = await import(`./component-generator.js?variant=unreachable`);
      const generator = new FreshGenerator();
      const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.aiAvailable, false);
      assert.equal(outcome.error, 'Code generation is temporarily unavailable.');
    } finally {
      process.env.AI_ROUTER_URL = badUrl;
    }
  });

  it('classifies an AI Router timeout distinctly from a genuine connection failure (reproduces the >150s failed-job durations seen in production)', async () => {
    // A server that accepts the connection but never responds triggers the
    // outer AbortSignal.timeout in callGateway — a materially different
    // failure than "connection refused", and must be reported as a timeout,
    // not blamed on the infrastructure being down.
    const hangingServer = http.createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, () => resolve()));
    const address = hangingServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const originalRouterUrl = process.env.AI_ROUTER_URL;
    const originalGatewayTimeout = process.env.AI_GATEWAY_TIMEOUT_MS;
    process.env.AI_ROUTER_URL = `http://127.0.0.1:${port}`;
    process.env.AI_GATEWAY_TIMEOUT_MS = '100';
    try {
      const { ComponentGenerator: TimeoutGenerator } = await import(`./component-generator.js?variant=timeout`);
      const generator = new TimeoutGenerator();
      const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
      // A timeout is a timeout regardless of which layer's clock fired it —
      // TIMED_OUT, not a generic FAILED, matches the job state machine.
      assert.equal(outcome.status, 'TIMED_OUT');
      assert.equal(outcome.errorCategory, 'MODEL_TIMEOUT');
      assert.equal(outcome.error, 'Code generation timed out. Please try again.');
      assert.notEqual(outcome.error, 'Code generation is temporarily unavailable.');
    } finally {
      process.env.AI_ROUTER_URL = originalRouterUrl;
      process.env.AI_GATEWAY_TIMEOUT_MS = originalGatewayTimeout;
      await new Promise((r) => hangingServer.close(() => r(undefined)));
    }
  });

  it('blocks before calling the AI Gateway at all when the selection contains a password field (Privacy Scrubber gate)', async () => {
    stub.mode = 'success';
    stub.requests.length = 0;
    const generator = new ComponentGenerator();

    const evidence = makeEvidence({
      element: makeNode({
        children: [{ tag: 'input', selector: 'input', attributes: { type: 'password', name: 'pwd' }, style: {}, boundingBox: { x: 0, y: 0, width: 10, height: 10 }, children: [] }],
      }),
    });

    const outcome = await generator.generate('https://example.com/login', 'REACT', evidence);

    assert.equal(outcome.status, 'BLOCKED_PRIVACY');
    assert.match(outcome.error ?? '', /password/);
    // Critical: the Privacy Scrubber gate must prevent ANY network call to the AI Gateway.
    assert.equal(stub.requests.length, 0);
  });

  it('retry (a second generate() call with the same evidence) can succeed after the model server recovers', async () => {
    stub.mode = 'unavailable';
    const generator = new ComponentGenerator();
    const first = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(first.status, 'FAILED');

    stub.mode = 'success';
    const retried = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(retried.status, 'COMPLETED');
  });

  it('returns CANCELLED without making any AI Gateway call when the signal is already aborted (Stop Generation clicked before this job was even dequeued)', async () => {
    stub.mode = 'success';
    stub.requests.length = 0;
    const generator = new ComponentGenerator();
    const controller = new AbortController();
    controller.abort();

    const outcome = await generator.generate('https://example.com/pricing', 'REACT', makeEvidence(), controller.signal);

    assert.equal(outcome.status, 'CANCELLED');
    assert.equal(stub.requests.length, 0);
  });

  it('aborts the in-flight AI Gateway request and returns CANCELLED when the signal fires mid-generation (real cancellation, not just abandoning interest in the result)', async () => {
    let serverSawAbort = false;
    const slowServer = http.createServer((req, res) => {
      req.resume(); // drain the request body so the abort isn't stuck behind an unread socket
      req.on('close', () => {
        if (!res.writableEnded) serverSawAbort = true;
      });
      // Never respond — the test aborts before this would matter.
    });
    await new Promise<void>((resolve) => slowServer.listen(0, () => resolve()));
    const address = slowServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const originalUrl2 = process.env.AI_ROUTER_URL;
    process.env.AI_ROUTER_URL = `http://127.0.0.1:${port}`;
    try {
      const { ComponentGenerator: SlowGenerator } = await import(`./component-generator.js?variant=midflight-cancel`);
      const generator = new SlowGenerator();
      const controller = new AbortController();

      const resultPromise = generator.generate('https://example.com/pricing', 'REACT', makeEvidence(), controller.signal);
      setTimeout(() => controller.abort(), 30);
      const outcome = await resultPromise;

      assert.equal(outcome.status, 'CANCELLED');
      assert.equal(outcome.result, undefined);
      // Give the server's 'close' handler a tick to fire.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(serverSawAbort, true, 'expected the outbound HTTP request to actually be aborted, not merely ignored client-side');
    } finally {
      process.env.AI_ROUTER_URL = originalUrl2;
      // An aborted fetch doesn't always fully tear down its TCP socket the
      // instant the client gives up on it (an undici/Node quirk, not
      // something our cancellation code controls) — http.Server#close()
      // alone would then wait ~4s for that lingering socket before its
      // callback fires. closeAllConnections() forces it immediately so this
      // test's teardown doesn't falsely read as slow cancellation.
      slowServer.closeAllConnections();
      await new Promise((r) => slowServer.close(() => r(undefined)));
    }
  });
});

// Real diagnosis: a real HTML_CSS generation returned syntactically valid
// JSON from generate_component that didn't use the canonical
// files:[{path,content}] shape, producing files.length===0 and a generic
// MODEL_ERROR. These tests exercise parseFiles()'s normalization/fallback
// tolerance directly through the public generate() API, using a stub
// generate_component response shaped exactly like the documented failure
// modes — no real model call, no mock/fake generated code (the "content"
// values here are just test fixtures standing in for whatever the model
// would have produced, same as every other test in this file).
describe('ComponentGenerator output parsing — normalizing reasonable equivalent model output shapes', () => {
  let stub: StubState;
  let originalUrl: string | undefined;
  let ComponentGenerator: typeof import('./component-generator.js').ComponentGenerator;

  before(async () => {
    stub = await startStubGateway();
    originalUrl = process.env.AI_ROUTER_URL;
    process.env.AI_ROUTER_URL = stub.url;
    ({ ComponentGenerator } = await import('./component-generator.js?variant=output-parsing'));
  });

  after(async () => {
    process.env.AI_ROUTER_URL = originalUrl;
    await new Promise((r) => stub.server.close(() => r(undefined)));
  });

  it('TEST 1 — canonical {files:[{path,content}]} still works', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      files: [{ path: 'Card.jsx', content: 'export function Card() { return null; }' }],
      dependencies: [], notes: [],
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result?.files.length, 1);
    assert.equal(outcome.result?.files[0].path, 'Card.jsx');
  });

  it('TEST 2 — {filename, content} normalizes to {path, content}', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      files: [{ filename: 'Card.jsx', content: 'export function Card() { return null; }' }],
      dependencies: [], notes: [],
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result?.files[0].path, 'Card.jsx');
    assert.ok(outcome.result?.files[0].content.includes('function Card'));
  });

  it('TEST 3 — {path, code} normalizes to {path, content}', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      files: [{ path: 'Card.jsx', code: 'export function Card() { return null; }' }],
      dependencies: [], notes: [],
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.ok(outcome.result?.files[0].content.includes('function Card'));
  });

  it('TEST 4 — {path, source} normalizes to {path, content}', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      files: [{ path: 'Card.jsx', source: 'export function Card() { return null; }' }],
      dependencies: [], notes: [],
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.ok(outcome.result?.files[0].content.includes('function Card'));
  });

  it('TEST 5 — HTML_CSS direct {html, css} shape normalizes into Card.html + Card.css', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      html: '<div class="card">Hi</div>',
      css: '.card { color: red; }',
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'HTML_CSS', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result?.files.length, 2);
    const html = outcome.result?.files.find((f) => f.path.endsWith('.html'));
    const css = outcome.result?.files.find((f) => f.path.endsWith('.css'));
    assert.equal(html?.path, 'card.html');
    assert.equal(css?.path, 'card.css');
    assert.equal(html?.content, '<div class="card">Hi</div>');
    assert.equal(css?.content, '.card { color: red; }');
  });

  it('TEST 6 — malformed output ({foo:"bar"}) yields [] and a controlled MODEL_ERROR', async () => {
    stub.customCodeResult = { foo: 'bar' };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.errorCategory, 'MODEL_ERROR');
    assert.equal(outcome.result, undefined);
  });

  it('TEST 7 — empty files array ({files:[]}) yields [] and a controlled MODEL_ERROR', async () => {
    stub.customCodeResult = { componentName: 'Card', files: [] };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.errorCategory, 'MODEL_ERROR');
  });

  it('TEST 8 — invalid entries are dropped; only the valid file survives', async () => {
    stub.customCodeResult = {
      componentName: 'Card',
      files: [null, {}, { path: '', content: '' }, { path: 'valid.jsx', content: 'export const x = 1;' }],
    };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'COMPLETED');
    assert.equal(outcome.result?.files.length, 1);
    assert.equal(outcome.result?.files[0].path, 'valid.jsx');
  });

  it('TEST 9 — REACT must NOT use the HTML/CSS direct-shape fallback', async () => {
    stub.customCodeResult = { componentName: 'Card', html: '<div>hi</div>', css: '.card{}' };
    const outcome = await new ComponentGenerator().generate('https://example.com/pricing', 'REACT', makeEvidence());
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.errorCategory, 'MODEL_ERROR');
    assert.equal(outcome.result, undefined, 'a React target must never silently accept an HTML/CSS-shaped response');
  });

  it('TEST 10 — canonical {files:[{path,content}]} works unchanged for every target', async () => {
    for (const target of ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'] as const) {
      stub.customCodeResult = {
        componentName: 'Card',
        files: [{ path: `Card${target === 'HTML_CSS' ? '.html' : '.jsx'}`, content: 'content' }],
        dependencies: [], notes: [],
      };
      const outcome = await new ComponentGenerator().generate('https://example.com/pricing', target, makeEvidence());
      assert.equal(outcome.status, 'COMPLETED', `canonical shape must work for ${target}`);
      assert.equal(outcome.result?.files.length, 1, `canonical shape must work for ${target}`);
    }
  });
});

// Real diagnosis (Step 5): a real HTML_CSS generation against
// https://betademo.berides.com/... was rejected by Ollama before any
// inference — "request (4879 tokens) exceeds the available context size
// (4096 tokens)" for qwen3-vl:8b-instruct. buildVisionEvidence() is the
// fix: a deterministic, structural (never blindly string-sliced) reduction
// of the screenshot_to_code evidence so it reliably fits a conservative
// token budget carved out of that same 4096-token ceiling.
describe('buildVisionEvidence — token-budgeted screenshot_to_code evidence (Step 5 context-overflow fix)', () => {
  let buildVisionEvidence: typeof import('./component-generator.js').buildVisionEvidence;
  let estimateTokens: typeof import('./component-generator.js').estimateTokens;
  let VISION_EVIDENCE_TOKEN_BUDGET: number;

  before(async () => {
    ({ buildVisionEvidence, estimateTokens, VISION_EVIDENCE_TOKEN_BUDGET } = await import('./component-generator.js'));
  });

  function evidenceTokens(payload: { element: unknown; ancestors: unknown; cssVariables: unknown; assets: unknown }): number {
    return estimateTokens(JSON.stringify({ element: payload.element, ancestors: payload.ancestors, cssVariables: payload.cssVariables, assets: payload.assets }));
  }

  /** A deeply-nested, wide subtree standing in for a real complex page element — long but harmless placeholder attribute values, never real page content. */
  function makeBigNode(label: string, depth: number, breadth: number): ComponentDomNode {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < 15; i++) attributes[`data-attr-${i}`] = `placeholder-value-${label}-${i}-${'x'.repeat(20)}`;
    return {
      tag: 'div',
      selector: `div.${label}`,
      classList: [label, 'wrapper', 'layout-block'],
      attributes,
      text: `placeholder text block ${label} `.repeat(5),
      style: { display: 'flex', position: 'relative', color: '#111111', backgroundColor: '#ffffff', fontSize: '14px' },
      boundingBox: { x: 0, y: 0, width: 400, height: 300 },
      children: depth <= 0 ? [] : Array.from({ length: breadth }, (_, i) => makeBigNode(`${label}-${i}`, depth - 1, breadth)),
    };
  }

  function bigCssVariables(count: number): Record<string, string> {
    const vars: Record<string, string> = {};
    for (let i = 0; i < count; i++) vars[`--design-token-${i}`] = `#${(i * 111111).toString(16).padStart(6, '0').slice(0, 6)}`;
    return vars;
  }

  // `alt` is padded so that even the pre-existing 20-asset baseline cap
  // (applied before any token-budget reduction runs) is, by itself, already
  // large enough to require the asset-specific reduction stages below 20 —
  // otherwise a bare "500 assets" count is indistinguishable from 20, since
  // the baseline cap already applies regardless of how many were supplied.
  function bigAssets(count: number) {
    return Array.from({ length: count }, (_, i) => ({ url: `https://example.com/asset-${i}.png`, type: 'image' as const, width: 200, height: 150, alt: `placeholder alt text for asset ${i} `.repeat(8) }));
  }

  it('TEST 1 — normal (small) evidence remains substantially intact and is not marked truncated', async () => {
    const safe = makeEvidence({ cssVariables: { '--brand': '#6d5ef6' }, assets: [{ url: 'https://example.com/logo.png', type: 'image' }] });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, false);
    assert.equal(result.element.selector, safe.element.selector);
    assert.deepEqual(result.cssVariables, safe.cssVariables);
    assert.deepEqual(result.assets, safe.assets);
  });

  it('TEST 2 — oversized evidence (huge cssVariables + wide/deep DOM) is reduced', async () => {
    const safe = makeEvidence({
      element: makeBigNode('root', 3, 4),
      ancestors: [makeBigNode('anc1', 2, 4), makeBigNode('anc2', 2, 4)],
      cssVariables: bigCssVariables(400),
      assets: bigAssets(100),
    });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, true);
    assert.ok(evidenceTokens(result) <= VISION_EVIDENCE_TOKEN_BUDGET, 'reduced evidence must fit the configured budget');
  });

  it('TEST 3 — reduction is deterministic (same input -> identical output)', async () => {
    const safe = makeEvidence({ element: makeBigNode('root', 3, 4), cssVariables: bigCssVariables(400), assets: bigAssets(100) });
    const a = buildVisionEvidence(safe, 'HTML_CSS');
    const b = buildVisionEvidence(safe, 'HTML_CSS');
    assert.deepEqual(a, b);
  });

  it('TEST 4 — the selected element/essential structure is preserved even after heavy reduction', async () => {
    const safe = makeEvidence({
      element: makeBigNode('selected-component', 3, 4),
      cssVariables: bigCssVariables(500),
      assets: bigAssets(200),
    });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, true);
    // The selected element itself is never dropped — its own tag/selector/
    // attributes survive even when its descendants and everything else do not.
    assert.equal(result.element.tag, 'div');
    assert.equal(result.element.selector, 'div.selected-component');
    assert.ok(Object.keys(result.element.attributes).length > 0, 'the selected element\'s own attributes must survive reduction');
  });

  it('TEST 5 — CSS variables are reduced before DOM structure is touched', async () => {
    // cssVariables alone is large enough to overflow the budget; the DOM
    // tree here is modest (well within the existing MAX_TREE_DEPTH/
    // MAX_CHILDREN_PER_NODE baseline) so reduction should stop at stage 1
    // without ever needing to touch tree breadth/depth.
    const safe = makeEvidence({ element: makeNode(), cssVariables: bigCssVariables(600), assets: [] });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, true);
    assert.ok(Object.keys(result.cssVariables).length < 600, 'cssVariables must have been reduced');
    // Baseline tree trimming (MAX_TREE_DEPTH/MAX_CHILDREN_PER_NODE) still
    // applies, but breadth/depth were never *additionally* cut beyond that
    // baseline for this modest tree — same child count as the untouched input.
    assert.equal(result.element.children.length, safe.element.children.length);
  });

  it('TEST 6 — assets are reduced before DOM structure is touched', async () => {
    const safe = makeEvidence({ element: makeNode(), cssVariables: {}, assets: bigAssets(500) });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, true);
    assert.ok(result.assets.length < 500, 'assets must have been reduced');
    assert.equal(result.element.children.length, safe.element.children.length);
  });

  it('TEST 7 — final evidence always stays under the configured conservative budget', async () => {
    const cases = [
      makeEvidence({ element: makeBigNode('a', 3, 4), cssVariables: bigCssVariables(400), assets: bigAssets(150) }),
      makeEvidence({ element: makeBigNode('b', 3, 4), cssVariables: bigCssVariables(50), assets: bigAssets(10) }),
      makeEvidence({ element: makeBigNode('c', 2, 3), ancestors: [makeBigNode('anc', 2, 3)], cssVariables: bigCssVariables(1000), assets: [] }),
    ];
    for (const safe of cases) {
      const result = buildVisionEvidence(safe, 'HTML_CSS');
      assert.ok(evidenceTokens(result) <= VISION_EVIDENCE_TOKEN_BUDGET, `must fit budget: got ${evidenceTokens(result)} > ${VISION_EVIDENCE_TOKEN_BUDGET}`);
    }
  });

  it('TEST 8 — a very large/pathological DOM cannot produce an oversized screenshot_to_code payload', async () => {
    // 4^4=256 nodes for the element plus three similarly-sized ancestors —
    // already ~1000 nodes with rich attributes/text, comfortably enough to
    // stress every reduction stage without eagerly materializing millions
    // of nodes in the test fixture itself (unrelated to the fix under test).
    const safe = makeEvidence({
      element: makeBigNode('huge', 4, 4),
      ancestors: [makeBigNode('anc1', 3, 4), makeBigNode('anc2', 3, 4), makeBigNode('anc3', 3, 4)],
      cssVariables: bigCssVariables(2000),
      assets: bigAssets(1000),
    });
    const result = buildVisionEvidence(safe, 'HTML_CSS');
    assert.equal(result.evidenceTruncated, true);
    assert.ok(evidenceTokens(result) <= VISION_EVIDENCE_TOKEN_BUDGET, `pathological DOM must still fit budget: got ${evidenceTokens(result)}`);
  });

  it('TEST 9 — the screenshot itself is always included, never reduced, even when evidence is heavily truncated', async () => {
    const stub = await startStubGateway();
    const originalUrl = process.env.AI_ROUTER_URL;
    process.env.AI_ROUTER_URL = stub.url;
    try {
      const { ComponentGenerator: FreshGenerator } = await import('./component-generator.js?variant=vision-evidence-screenshot');
      const evidence = makeEvidence({
        screenshotBase64: 'dGhpcy1pcy1hLWZha2Utc2NyZWVuc2hvdC1mb3ItdGVzdGluZw==',
        element: makeBigNode('root', 3, 4),
        cssVariables: bigCssVariables(500),
        assets: bigAssets(200),
      });
      const generator = new FreshGenerator();
      await generator.generate('https://example.com/pricing', 'HTML_CSS', evidence);

      assert.equal(stub.requests.length >= 1, true);
      const visionRequest = stub.requests.find((r) => r.task === 'screenshot_to_code');
      assert.ok(visionRequest);
      assert.equal((visionRequest!.payload as { imageBase64: string }).imageBase64, evidence.screenshotBase64, 'the screenshot must be sent unchanged regardless of how much other evidence was reduced');
    } finally {
      process.env.AI_ROUTER_URL = originalUrl;
      await new Promise((r) => stub.server.close(() => r(undefined)));
    }
  });

  it('TESTS 10-13 — existing REACT/NEXT_JS/TAILWIND/HTML_CSS generation remains compatible with typical (non-oversized) evidence', async () => {
    for (const target of ['REACT', 'NEXT_JS', 'TAILWIND', 'HTML_CSS'] as const) {
      const safe = makeEvidence();
      const result = buildVisionEvidence(safe, target);
      assert.equal(result.evidenceTruncated, false, `typical evidence must not be truncated for ${target}`);
    }
  });
});
