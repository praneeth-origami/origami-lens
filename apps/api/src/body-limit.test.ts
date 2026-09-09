import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

// index.ts computes MAX_REQUEST_BODY_BYTES and passes it into Fastify() at
// module load time (a side-effecting import that also starts listening on
// API_PORT), so it can't be imported directly here without colliding with a
// real dev server on the same port. This mirrors that exact formula instead
// — see index.ts and services/ai-router/src/index.ts for the live copies —
// and proves the formula plus Fastify's actual bodyLimit enforcement, which
// is what the 413 regression (Fastify's silent 1MB default) was really about.
function maxRequestBodyBytes(): number {
  return Number(process.env.MAX_REQUEST_BODY_MB || 8) * 1024 * 1024;
}

describe('request body size limit (Screenshot -> Code evidence payloads)', () => {
  const originalEnv = process.env.MAX_REQUEST_BODY_MB;
  after(() => {
    process.env.MAX_REQUEST_BODY_MB = originalEnv;
  });

  it('defaults to 8MB when MAX_REQUEST_BODY_MB is unset', () => {
    delete process.env.MAX_REQUEST_BODY_MB;
    assert.equal(maxRequestBodyBytes(), 8 * 1024 * 1024);
  });

  it('honors an explicit MAX_REQUEST_BODY_MB override', () => {
    process.env.MAX_REQUEST_BODY_MB = '2';
    assert.equal(maxRequestBodyBytes(), 2 * 1024 * 1024);
  });

  it('accepts a realistic Screenshot -> Code evidence payload (~1.5MB) that Fastify\'s 1MB default previously rejected with 413', async () => {
    delete process.env.MAX_REQUEST_BODY_MB;
    const app = Fastify({ bodyLimit: maxRequestBodyBytes() });
    app.post('/components', async (request) => ({ received: true, bytes: JSON.stringify(request.body).length }));
    await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      // ~1.5MB base64 string standing in for a real cropped, high-DPR
      // screenshot (JPEG q=0.85 + ~37% base64 overhead) plus a bit of DOM
      // evidence padding — comfortably over Fastify's old 1MB default, and
      // exactly the size class that was silently 413ing before this fix.
      const screenshotBase64 = 'A'.repeat(1_500_000);
      const body = JSON.stringify({
        target: 'HTML_CSS',
        evidence: {
          sourceUrl: 'https://example.com/pricing',
          screenshotBase64,
          element: { tag: 'div', selector: 'div', attributes: {}, style: {}, boundingBox: { x: 0, y: 0, width: 1, height: 1 }, children: [] },
        },
      });

      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/components`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      assert.equal(res.status, 200, 'a realistic evidence payload must be accepted, not rejected with 413');
    } finally {
      await app.close();
    }
  });

  it('still rejects a payload larger than the configured limit (the limit is real, not accidentally unbounded)', async () => {
    process.env.MAX_REQUEST_BODY_MB = '1';
    const app = Fastify({ bodyLimit: maxRequestBodyBytes() });
    app.post('/components', async () => ({ received: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const body = JSON.stringify({ junk: 'A'.repeat(1_200_000) });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/components`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        assert.equal(res.status, 413);
      } catch (error) {
        // Fastify/Node sometimes close the connection as soon as the body
        // exceeds bodyLimit, before the client finishes writing it — undici
        // then reports this as a connection-level failure rather than a
        // clean 413 response. Either outcome proves the same thing (the
        // oversized payload was rejected, not silently accepted), so both
        // are accepted here rather than asserting one specific transport
        // behavior that can legitimately vary with timing/load.
        assert.match((error as Error).message, /fetch failed/i, `expected either a 413 response or a connection-level rejection, got: ${(error as Error).message}`);
      }
    } finally {
      await app.close();
    }
  });
});
