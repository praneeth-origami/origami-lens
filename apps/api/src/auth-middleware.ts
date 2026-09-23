import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@origami/contracts';
import type { SessionRepository } from './db/session-repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const SESSION_COOKIE_NAME = 'origami_session';

function isSecureRequest(request: FastifyRequest): boolean {
  // Trust the proxy-set header only insofar as it decides an attribute on
  // OUR OWN response cookie — never used for any authorization decision.
  return request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
}

export function sessionCookieOptions(request: FastifyRequest, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(request),
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/**
 * Reads the session cookie, resolves it against the real sessions table,
 * and — if valid — decorates request.user. Never throws and never rejects
 * the request itself; routes that require authentication use requireAuth
 * below instead. Used for endpoints like GET /auth/me that report the
 * current signed-in state (or null) rather than gate access.
 */
export function createAuthMiddleware(sessionRepo: SessionRepository) {
  async function populateUser(request: FastifyRequest): Promise<void> {
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) return;
    if (!sessionRepo.isEnabled()) return;

    const session = await sessionRepo.getValidByIdAndTouch(sessionId);
    if (session) request.user = session.user;
  }

  /** Route-level gate for any endpoint that must reject an unauthenticated caller. Service-layer code must still perform its own ownership check against request.user.id — this only proves *someone* is signed in, not that they own the specific resource being touched. */
  async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await populateUser(request);
    if (!request.user) {
      reply.status(401).send({ error: 'Authentication required.', errorCode: 'UNAUTHENTICATED' });
      return;
    }
  }

  return { populateUser, requireAuth };
}
