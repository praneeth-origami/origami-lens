import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

/**
 * Phase 16/B — proves the REAL authentication + ownership boundary end to
 * end over actual HTTP, not just at the unit level. Uses the real
 * UnifiedRepositoryStore and the real createAuthMiddleware/requireAuth from
 * auth-middleware.ts — the only thing faked is the SessionRepository's
 * backing store (an in-memory Map instead of Postgres), so these tests run
 * without a real database while still exercising the actual security code.
 *
 * index.ts itself can't be imported directly here (it has side effects —
 * it starts listening on API_PORT at module load — see
 * body-limit.test.ts's identical note), so this builds a small, honest
 * two-route harness using the real store/middleware modules, mirroring
 * exactly how index.ts wires them.
 */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-repo-http-test-'));
process.env.SCAN_DATA_DIR = DATA_DIR;
process.env.DATABASE_URL = '';

const { UnifiedRepositoryStore } = await import('./unified-repository-store.js');
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

async function buildApp() {
  const repositoryStore = new UnifiedRepositoryStore();
  const sessionRepo = new FakeSessionRepository();
  const authMiddleware = createAuthMiddleware(sessionRepo as unknown as Parameters<typeof authMiddlewareModule.createAuthMiddleware>[0]);

  const app = Fastify();
  await app.register(cookie);

  // Mirrors index.ts's real POST/GET /repositories and GET /repositories/:id
  // exactly: requireAuth preHandler, ownership derived only from
  // request.user.id, getByIdForUserAsync for the single-resource read.
  app.post<{ Body: { repoUrl: string; branch?: string } }>('/repositories', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const repository = await repositoryStore.create({
      id: randomUUID(),
      userId: request.user!.id,
      repoUrl: request.body.repoUrl,
      provider: 'GITHUB',
      branch: request.body.branch ?? 'main',
    });
    return reply.status(201).send(repository);
  });

  app.get('/repositories', { preHandler: authMiddleware.requireAuth }, async (request) => {
    return { repositories: await repositoryStore.listForUserAsync(request.user!.id) };
  });

  app.get<{ Params: { id: string } }>('/repositories/:id', { preHandler: authMiddleware.requireAuth }, async (request, reply) => {
    const repository = await repositoryStore.getByIdForUserAsync(request.params.id, request.user!.id);
    if (!repository) return reply.status(404).send({ error: 'Repository not found' });
    return repository;
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, port, sessionRepo };
}

function registerUser(sessionRepo: FakeSessionRepository, login: string): { sessionId: string; cookieHeader: string } {
  const sessionId = randomUUID();
  sessionRepo.registerSession(sessionId, { id: randomUUID(), primaryProvider: 'GITHUB', primaryProviderLogin: login });
  return { sessionId, cookieHeader: `${SESSION_COOKIE_NAME}=${sessionId}` };
}

describe('Phase 16/B — HTTP authentication + ownership (real requireAuth + real UnifiedRepositoryStore)', () => {
  it('AUTHENTICATION — an unauthenticated repository request is rejected with 401, never reaching the store', async () => {
    const { app, port } = await buildApp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/repositories`);
      assert.equal(res.status, 401);
      const body = (await res.json()) as { errorCode?: string };
      assert.equal(body.errorCode, 'UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });

  it('AUTHENTICATION — a valid session cookie is accepted and the request succeeds', async () => {
    const { app, port, sessionRepo } = await buildApp();
    try {
      const { cookieHeader } = registerUser(sessionRepo, 'user-a');
      const res = await fetch(`http://127.0.0.1:${port}/repositories`, { headers: { Cookie: cookieHeader } });
      assert.equal(res.status, 200);
    } finally {
      await app.close();
    }
  });

  it('OWNERSHIP — a repository created by User A belongs to User A and is listed for them', async () => {
    const { app, port, sessionRepo } = await buildApp();
    try {
      const { cookieHeader } = registerUser(sessionRepo, 'user-a');
      const createRes = await fetch(`http://127.0.0.1:${port}/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({ repoUrl: 'https://github.com/facebook/react' }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { id: string; userId: string };
      assert.ok(created.userId, 'the created repository must record a real owning userId');

      const listRes = await fetch(`http://127.0.0.1:${port}/repositories`, { headers: { Cookie: cookieHeader } });
      const { repositories } = (await listRes.json()) as { repositories: Array<{ id: string }> };
      assert.ok(repositories.some((r) => r.id === created.id));
    } finally {
      await app.close();
    }
  });

  it('IDOR — User B cannot read User A\'s repository by its real UUID (404, not 403 — never confirms existence)', async () => {
    const { app, port, sessionRepo } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');

      const createRes = await fetch(`http://127.0.0.1:${port}/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userA.cookieHeader },
        body: JSON.stringify({ repoUrl: 'https://github.com/facebook/react' }),
      });
      const created = (await createRes.json()) as { id: string };

      const res = await fetch(`http://127.0.0.1:${port}/repositories/${created.id}`, { headers: { Cookie: userB.cookieHeader } });
      assert.equal(res.status, 404);

      // The real owner can still read it.
      const okRes = await fetch(`http://127.0.0.1:${port}/repositories/${created.id}`, { headers: { Cookie: userA.cookieHeader } });
      assert.equal(okRes.status, 200);
    } finally {
      await app.close();
    }
  });

  it('IDOR — User B\'s repository list never includes User A\'s repositories', async () => {
    const { app, port, sessionRepo } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');

      await fetch(`http://127.0.0.1:${port}/repositories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: userA.cookieHeader },
        body: JSON.stringify({ repoUrl: 'https://github.com/facebook/react' }),
      });

      const listRes = await fetch(`http://127.0.0.1:${port}/repositories`, { headers: { Cookie: userB.cookieHeader } });
      const { repositories } = (await listRes.json()) as { repositories: unknown[] };
      assert.equal(repositories.length, 0);
    } finally {
      await app.close();
    }
  });

  it('CLIENT ownerId — a client-supplied field claiming another user\'s identity has no effect; ownership is always request.user.id', async () => {
    const { app, port, sessionRepo } = await buildApp();
    try {
      const userA = registerUser(sessionRepo, 'user-a');
      const userB = registerUser(sessionRepo, 'user-b');

      // Attacker (User B) tries to plant a userId/ownerId field in the body
      // pointing at User A — the route never reads it (see /repositories
      // above: userId is always request.user!.id), so the created
      // repository still belongs to User B, not the impersonated User A.
      const res = await fetch(`http://127.0.0.1:${port}/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: userB.cookieHeader },
        body: JSON.stringify({ repoUrl: 'https://github.com/facebook/react', ownerId: 'attacker-supplied-value', userId: 'attacker-supplied-value' }),
      });
      const created = (await res.json()) as { userId?: string };
      assert.notEqual(created.userId, 'attacker-supplied-value');

      // And User A never sees it in their own list.
      const userAList = await fetch(`http://127.0.0.1:${port}/repositories`, { headers: { Cookie: userA.cookieHeader } });
      const { repositories } = (await userAList.json()) as { repositories: unknown[] };
      assert.equal(repositories.length, 0);
    } finally {
      await app.close();
    }
  });
});
