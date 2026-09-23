import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

/**
 * UX audit follow-up — proves the REAL organization-ownership boundary for
 * scans end to end over actual HTTP, not just at the unit level. Mirrors
 * repository-http-ownership.test.ts exactly: uses the real UnifiedScanStore
 * and the real createAuthMiddleware/requireAuth from auth-middleware.ts, the
 * only thing faked is the SessionRepository's backing store. This is what
 * regresses if "Recent Scans"/"/scans" ever again shows a user someone
 * else's scan history.
 *
 * index.ts itself can't be imported directly here (side effects at module
 * load — see body-limit.test.ts's identical note), so this builds a small,
 * honest route harness using the real store/middleware modules, mirroring
 * exactly how index.ts wires /scans and /scans/:scanId.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-scan-http-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';

const { UnifiedScanStore } = await import('./unified-scan-store.js');
const { createAuthMiddleware, SESSION_COOKIE_NAME } = await import('./auth-middleware.js');
const authMiddlewareModule = await import('./auth-middleware.js');
type AuthUser = { id: string; primaryProvider: 'GITHUB'; primaryProviderLogin: string };
type SessionWithUser = { sessionId: string; expiresAt: string; user: AuthUser };

/** In-memory stand-in for db/session-repository.ts's SessionRepository — same public shape, backed by a Map instead of Postgres. Never a bypass: createAuthMiddleware/requireAuth are the REAL Phase A modules, unmodified. */
class FakeSessionRepository {
  private sessions = new Map<string, SessionWithUser>();

  isEnabled(): boolean {
    return true;
  }

  registerSession(sessionId: string, user: AuthUser): void {
    this.sessions.set(sessionId, { sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString(), user });
  }

  async getValidByIdAndTouch(sessionId: string): Promise<SessionWithUser | undefined> {
    return this.sessions.get(sessionId);
  }

  async create(): Promise<void> {}
  async deleteById(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async deleteExpired(): Promise<number> { return 0; }
}

function fakeScan(scanId: string, organizationId: string, url: string) {
  return {
    scanId,
    url,
    scanType: 'CURRENT_PAGE' as const,
    status: 'COMPLETED' as const,
    healthScore: { overallScore: 100, categories: {} as never },
    issues: [],
    summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, aiAvailable: false },
    scannedAt: new Date().toISOString(),
    organizationId,
  };
}

async function buildApp() {
  const scanStore = new UnifiedScanStore();
  const sessionRepo = new FakeSessionRepository();
  const authMiddleware = createAuthMiddleware(sessionRepo as unknown as Parameters<typeof authMiddlewareModule.createAuthMiddleware>[0]);

  const app = Fastify();
  await app.register(cookie);

  // Mirrors index.ts's real GET /scans and GET /scans/:scanId exactly:
  // requireAuth preHandler, ownership resolved only from request.user.id (via
  // each user's own id standing in for their organization id here, the same
  // no-DB-fallback convention resolveOrganizationIds itself uses in index.ts).
  app.get('/scans', { preHandler: authMiddleware.requireAuth }, async (request) => {
    return { scans: await scanStore.listScansForOrganizationsAsync([request.user!.id]) };
  });

  app.get<{ Params: { scanId: string } }>('/scans/:scanId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const scan = await scanStore.getScanForOrganizationsAsync(request.params.scanId, [request.user!.id]);
    if (!scan) return reply.status(404).send({ error: 'Scan not found' });
    return scan;
  });

  app.delete<{ Params: { scanId: string } }>('/scans/:scanId', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const deleted = await scanStore.deleteScanForOrganizationsAsync(request.params.scanId, [request.user!.id]);
    if (!deleted) return reply.status(404).send({ error: 'Scan not found' });
    return { ok: true };
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, port, sessionRepo, scanStore };
}

function registerUser(sessionRepo: FakeSessionRepository, login: string): { userId: string; cookieHeader: string } {
  const sessionId = randomUUID();
  const userId = randomUUID();
  sessionRepo.registerSession(sessionId, { id: userId, primaryProvider: 'GITHUB', primaryProviderLogin: login });
  return { userId, cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}` };
}

describe('UX audit follow-up — HTTP organization ownership for scans (real requireAuth + real UnifiedScanStore)', () => {
  it('AUTHENTICATION — an unauthenticated scans request is rejected with 401, never reaching the store', async () => {
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/scans`);
      assert.equal(res.status, 401);
    } finally {
      await app.close();
    }
  });

  it('IDOR — User B\'s scan list never includes User A\'s scans (the exact bug reported: a logged-in user seeing someone else\'s "Recent Scans")', async () => {
    const { app, port, sessionRepo, scanStore } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');

      scanStore.saveScan(fakeScan(randomUUID(), userA.userId, 'https://user-a-site.example.com'));
      scanStore.saveScan(fakeScan(randomUUID(), userB.userId, 'https://user-b-site.example.com'));

      const listRes = await fetch(`http://127.0.0.1:${port}/scans`, { headers: { Cookie: userB.cookieHeader } });
      const { scans } = (await listRes.json()) as { scans: Array<{ url: string }> };

      assert.equal(scans.length, 1);
      assert.equal(scans[0].url, 'https://user-b-site.example.com');
    } finally {
      await app.close();
    }
  });

  it('IDOR — User B cannot read User A\'s scan by its real scanId (404, not 403 — never confirms existence)', async () => {
    const { app, port, sessionRepo, scanStore } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');
      const scanId = randomUUID();
      scanStore.saveScan(fakeScan(scanId, userA.userId, 'https://user-a-site.example.com'));

      const res = await fetch(`http://127.0.0.1:${port}/scans/${scanId}`, { headers: { Cookie: userB.cookieHeader } });
      assert.equal(res.status, 404);

      const okRes = await fetch(`http://127.0.0.1:${port}/scans/${scanId}`, { headers: { Cookie: userA.cookieHeader } });
      assert.equal(okRes.status, 200);
    } finally {
      await app.close();
    }
  });

  it('a scan with no organizationId (a legacy pre-migration row) is inaccessible to everyone — a deliberate tradeoff, not a bug', async () => {
    const { app, port, sessionRepo, scanStore } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const scanId = randomUUID();
      scanStore.saveScan({ ...fakeScan(scanId, userA.userId, 'https://orphaned.example.com'), organizationId: undefined });

      const res = await fetch(`http://127.0.0.1:${port}/scans/${scanId}`, { headers: { Cookie: userA.cookieHeader } });
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });

  it('IDOR — User B cannot delete User A\'s scan (404, not deleted), and User A can still delete their own afterward', async () => {
    const { app, port, sessionRepo, scanStore } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');
      const scanId = randomUUID();
      scanStore.saveScan(fakeScan(scanId, userA.userId, 'https://user-a-site.example.com'));

      const deleteByB = await fetch(`http://127.0.0.1:${port}/scans/${scanId}`, { method: 'DELETE', headers: { Cookie: userB.cookieHeader } });
      assert.equal(deleteByB.status, 404);
      assert.ok(await scanStore.getScanForOrganizationsAsync(scanId, [userA.userId]), 'the scan must survive an attempted delete by a non-owner');

      const deleteByA = await fetch(`http://127.0.0.1:${port}/scans/${scanId}`, { method: 'DELETE', headers: { Cookie: userA.cookieHeader } });
      assert.equal(deleteByA.status, 200);
      assert.equal(await scanStore.getScanForOrganizationsAsync(scanId, [userA.userId]), undefined);
    } finally {
      await app.close();
    }
  });
});
