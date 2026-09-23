import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthUser } from '@origami/contracts';
import {
  PasswordAuthError,
  loginWithEmail,
  registerWithEmail,
  requestPasswordReset,
  resetPassword,
  confirmEmailVerification,
  resendVerificationEmail,
  type PasswordAuthUserRepo,
  type PasswordResetTokenRepo,
  type EmailVerificationTokenRepo,
} from './password-auth-service.js';
import { hashPassword } from './password-hash.js';
import { EmailNotConfiguredError } from './email-service.js';

const noopSessionRepo = { create: async () => {}, getValidByIdAndTouch: async () => undefined, deleteById: async () => {} };

function fakeUserRepo(overrides: Partial<PasswordAuthUserRepo> = {}): PasswordAuthUserRepo {
  return {
    findByEmail: async () => undefined,
    findByEmailWithPasswordHash: async () => undefined,
    createEmailUser: async (input) => ({ id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: input.displayName, email: input.email, displayName: input.displayName }),
    updatePasswordHash: async () => {},
    getById: async () => undefined,
    updateEmailVerified: async () => {},
    ...overrides,
  };
}

function fakeTokenRepo(overrides: Partial<EmailVerificationTokenRepo> = {}): EmailVerificationTokenRepo {
  return {
    create: async () => {},
    findValidByTokenHash: async () => undefined,
    markUsed: async () => {},
    ...overrides,
  };
}

describe('password-auth-service — registerWithEmail', () => {
  it('creates a user, ensures a personal organization, and returns a session', async () => {
    const orgCalls: Array<{ userId: string }> = [];
    const result = await registerWithEmail(
      { email: 'Jane@Example.com', password: 'correcthorse1', displayName: 'Jane Doe' },
      {
        userRepo: fakeUserRepo(),
        sessionRepo: noopSessionRepo,
        organizationRepo: { getOrCreatePersonalOrganization: async (userId) => { orgCalls.push({ userId }); return { id: 'org-1' }; } },
      },
    );
    assert.equal(result.user.email, 'jane@example.com'); // normalized to lowercase
    assert.ok(result.sessionId);
    assert.equal(orgCalls.length, 1);
    assert.equal(orgCalls[0].userId, 'user-1');
  });

  it('rejects a registration for an email that already exists', async () => {
    const existing: AuthUser = { id: 'user-existing', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    await assert.rejects(
      () => registerWithEmail(
        { email: 'jane@example.com', password: 'correcthorse1', displayName: 'Jane' },
        { userRepo: fakeUserRepo({ findByEmail: async () => existing }), sessionRepo: noopSessionRepo },
      ),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'EMAIL_ALREADY_REGISTERED',
    );
  });

  it('rejects a password shorter than 8 characters', async () => {
    await assert.rejects(
      () => registerWithEmail({ email: 'jane@example.com', password: 'short1', displayName: 'Jane' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'WEAK_PASSWORD',
    );
  });

  it('rejects a password with no digit', async () => {
    await assert.rejects(
      () => registerWithEmail({ email: 'jane@example.com', password: 'allletters', displayName: 'Jane' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'WEAK_PASSWORD',
    );
  });

  it('rejects an invalid email address', async () => {
    await assert.rejects(
      () => registerWithEmail({ email: 'not-an-email', password: 'correcthorse1', displayName: 'Jane' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'INVALID_CREDENTIALS',
    );
  });

  it('rejects a blank display name', async () => {
    await assert.rejects(
      () => registerWithEmail({ email: 'jane@example.com', password: 'correcthorse1', displayName: '   ' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'INVALID_CREDENTIALS',
    );
  });

  it('still succeeds when organizationRepo is omitted', async () => {
    const result = await registerWithEmail({ email: 'jane@example.com', password: 'correcthorse1', displayName: 'Jane' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo });
    assert.ok(result.sessionId);
  });
});

describe('password-auth-service — loginWithEmail', () => {
  it('logs in successfully with the correct password', async () => {
    const hash = await hashPassword('correcthorse1');
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    const result = await loginWithEmail(
      { email: 'jane@example.com', password: 'correcthorse1' },
      { userRepo: fakeUserRepo({ findByEmailWithPasswordHash: async () => ({ user, passwordHash: hash }) }), sessionRepo: noopSessionRepo },
    );
    assert.equal(result.user.id, 'user-1');
  });

  it('rejects an unknown email with the generic INVALID_CREDENTIALS code', async () => {
    await assert.rejects(
      () => loginWithEmail({ email: 'nobody@example.com', password: 'whatever1' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'INVALID_CREDENTIALS',
    );
  });

  it('rejects a wrong password with the SAME generic INVALID_CREDENTIALS code as an unknown email (no account enumeration)', async () => {
    const hash = await hashPassword('correcthorse1');
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    let caughtMessage = '';
    try {
      await loginWithEmail(
        { email: 'jane@example.com', password: 'wrongpassword1' },
        { userRepo: fakeUserRepo({ findByEmailWithPasswordHash: async () => ({ user, passwordHash: hash }) }), sessionRepo: noopSessionRepo },
      );
      assert.fail('expected loginWithEmail to reject');
    } catch (error) {
      assert.ok(error instanceof PasswordAuthError);
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      caughtMessage = error.message;
    }

    try {
      await loginWithEmail({ email: 'nobody@example.com', password: 'whatever1' }, { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo });
      assert.fail('expected loginWithEmail to reject');
    } catch (error) {
      assert.ok(error instanceof PasswordAuthError);
      assert.equal(error.message, caughtMessage);
    }
  });

  it('rejects a login for an OAuth-only account (no password hash set)', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'GITHUB', primaryProviderLogin: 'octocat', email: 'jane@example.com' };
    await assert.rejects(
      () => loginWithEmail(
        { email: 'jane@example.com', password: 'whatever1' },
        { userRepo: fakeUserRepo({ findByEmailWithPasswordHash: async () => ({ user, passwordHash: null }) }), sessionRepo: noopSessionRepo },
      ),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'INVALID_CREDENTIALS',
    );
  });
});

describe('password-auth-service — requestPasswordReset', () => {
  it('creates a token and sends an email when the address belongs to a real user', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    const tokenCreates: unknown[] = [];
    const sentTo: string[] = [];

    await requestPasswordReset('jane@example.com', {
      userRepo: fakeUserRepo({ findByEmail: async () => user }),
      tokenRepo: { create: async (input) => { tokenCreates.push(input); }, findValidByTokenHash: async () => undefined, markUsed: async () => {} },
      sendPasswordResetEmail: async (to) => { sentTo.push(to); },
      sendPasswordChangedEmail: async () => {},
      webAppBaseUrl: 'http://localhost:5173',
    });

    assert.equal(tokenCreates.length, 1);
    assert.equal((tokenCreates[0] as { userId: string }).userId, 'user-1');
    assert.deepEqual(sentTo, ['jane@example.com']);
  });

  it('is a silent no-op for an email with no account — never creates a token, never throws (no account enumeration)', async () => {
    const tokenCreates: unknown[] = [];
    await requestPasswordReset('nobody@example.com', {
      userRepo: fakeUserRepo(),
      tokenRepo: { create: async (input) => { tokenCreates.push(input); }, findValidByTokenHash: async () => undefined, markUsed: async () => {} },
      sendPasswordResetEmail: async () => { throw new Error('should never be called'); },
      sendPasswordChangedEmail: async () => { throw new Error('should never be called'); },
      webAppBaseUrl: 'http://localhost:5173',
    });
    assert.equal(tokenCreates.length, 0);
  });

  it('never throws even when the email provider is not configured — resolves normally regardless', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    await requestPasswordReset('jane@example.com', {
      userRepo: fakeUserRepo({ findByEmail: async () => user }),
      tokenRepo: { create: async () => {}, findValidByTokenHash: async () => undefined, markUsed: async () => {} },
      sendPasswordResetEmail: async () => { throw new EmailNotConfiguredError(); },
      sendPasswordChangedEmail: async () => {},
      webAppBaseUrl: 'http://localhost:5173',
    });
    // No assertion needed beyond "did not throw" — the whole point is this never surfaces to the caller.
  });
});

describe('password-auth-service — resetPassword', () => {
  it('updates the password hash, marks the token used, and sends a best-effort confirmation email', async () => {
    const updates: Array<{ userId: string }> = [];
    const markedUsed: string[] = [];
    const changedEmailsSentTo: string[] = [];
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };

    await resetPassword('raw-token-value', 'newpassword1', {
      userRepo: fakeUserRepo({ updatePasswordHash: async (userId) => { updates.push({ userId }); }, getById: async () => user }),
      tokenRepo: {
        create: async () => {},
        findValidByTokenHash: async () => ({ id: 'token-1', userId: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        markUsed: async (id) => { markedUsed.push(id); },
      },
      sendPasswordChangedEmail: async (to) => { changedEmailsSentTo.push(to); },
      webAppBaseUrl: 'http://localhost:5173',
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].userId, 'user-1');
    assert.deepEqual(markedUsed, ['token-1']);
    assert.deepEqual(changedEmailsSentTo, ['jane@example.com']);
  });

  it('still succeeds even when the confirmation email send fails', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    await resetPassword('raw-token-value', 'newpassword1', {
      userRepo: fakeUserRepo({ getById: async () => user }),
      tokenRepo: {
        create: async () => {},
        findValidByTokenHash: async () => ({ id: 'token-1', userId: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        markUsed: async () => {},
      },
      sendPasswordChangedEmail: async () => { throw new Error('SMTP down'); },
      webAppBaseUrl: 'http://localhost:5173',
    });
    // No assertion needed beyond "did not throw".
  });

  it('rejects an invalid/expired/already-used token (tokenRepo returns undefined for all three) without ever updating the password', async () => {
    let updated = false;
    await assert.rejects(
      () => resetPassword('bad-token', 'newpassword1', {
        userRepo: fakeUserRepo({ updatePasswordHash: async () => { updated = true; } }),
        tokenRepo: { create: async () => {}, findValidByTokenHash: async () => undefined, markUsed: async () => {} },
        sendPasswordChangedEmail: async () => {},
        webAppBaseUrl: 'http://localhost:5173',
      }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'RESET_TOKEN_INVALID',
    );
    assert.equal(updated, false);
  });

  it('rejects a weak new password before ever looking up the token', async () => {
    let tokenLookedUp = false;
    await assert.rejects(
      () => resetPassword('some-token', 'short', {
        userRepo: fakeUserRepo(),
        tokenRepo: { create: async () => {}, findValidByTokenHash: async () => { tokenLookedUp = true; return undefined; }, markUsed: async () => {} },
        sendPasswordChangedEmail: async () => {},
        webAppBaseUrl: 'http://localhost:5173',
      }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'WEAK_PASSWORD',
    );
    assert.equal(tokenLookedUp, false);
  });
});

describe('password-auth-service — registerWithEmail sends a verification email (additive, best-effort)', () => {
  it('sends a verification email when emailVerification deps are provided', async () => {
    const created: unknown[] = [];
    const sentTo: string[] = [];
    const result = await registerWithEmail(
      { email: 'jane@example.com', password: 'correcthorse1', displayName: 'Jane' },
      {
        userRepo: fakeUserRepo(),
        sessionRepo: noopSessionRepo,
        emailVerification: {
          tokenRepo: fakeTokenRepo({ create: async (input) => { created.push(input); } }),
          sendEmailVerificationEmail: async (to) => { sentTo.push(to); },
          webAppBaseUrl: 'http://localhost:5173',
        },
      },
    );
    assert.ok(result.sessionId);
    assert.equal(created.length, 1);
    assert.deepEqual(sentTo, ['jane@example.com']);
  });

  it('does not attempt to send anything when emailVerification deps are omitted', async () => {
    const result = await registerWithEmail(
      { email: 'jane@example.com', password: 'correcthorse1', displayName: 'Jane' },
      { userRepo: fakeUserRepo(), sessionRepo: noopSessionRepo },
    );
    assert.ok(result.sessionId); // registration itself is unaffected either way
  });

  it('registration still succeeds even when the verification email send fails', async () => {
    const result = await registerWithEmail(
      { email: 'jane@example.com', password: 'correcthorse1', displayName: 'Jane' },
      {
        userRepo: fakeUserRepo(),
        sessionRepo: noopSessionRepo,
        emailVerification: {
          tokenRepo: fakeTokenRepo(),
          sendEmailVerificationEmail: async () => { throw new Error('SMTP down'); },
          webAppBaseUrl: 'http://localhost:5173',
        },
      },
    );
    assert.ok(result.sessionId);
  });
});

describe('password-auth-service — confirmEmailVerification', () => {
  it('marks the user verified and the token used for a valid token', async () => {
    const verifiedUserIds: string[] = [];
    const markedUsed: string[] = [];
    await confirmEmailVerification('raw-token', {
      userRepo: { updateEmailVerified: async (id) => { verifiedUserIds.push(id); } },
      tokenRepo: fakeTokenRepo({
        findValidByTokenHash: async () => ({ id: 'token-1', userId: 'user-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
        markUsed: async (id) => { markedUsed.push(id); },
      }),
    });
    assert.deepEqual(verifiedUserIds, ['user-1']);
    assert.deepEqual(markedUsed, ['token-1']);
  });

  it('rejects an invalid/expired/already-used token without marking anyone verified', async () => {
    let verified = false;
    await assert.rejects(
      () => confirmEmailVerification('bad-token', {
        userRepo: { updateEmailVerified: async () => { verified = true; } },
        tokenRepo: fakeTokenRepo(),
      }),
      (error: unknown) => error instanceof PasswordAuthError && error.code === 'VERIFICATION_TOKEN_INVALID',
    );
    assert.equal(verified, false);
  });
});

describe('password-auth-service — resendVerificationEmail', () => {
  it('sends a fresh verification email for an existing, unverified account', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com' };
    const sentTo: string[] = [];
    await resendVerificationEmail('jane@example.com', {
      userRepo: fakeUserRepo({ findByEmail: async () => user }),
      tokenRepo: fakeTokenRepo(),
      sendEmailVerificationEmail: async (to) => { sentTo.push(to); },
      webAppBaseUrl: 'http://localhost:5173',
    });
    assert.deepEqual(sentTo, ['jane@example.com']);
  });

  it('is a silent no-op for an unknown email (no account enumeration)', async () => {
    const sentTo: string[] = [];
    await resendVerificationEmail('nobody@example.com', {
      userRepo: fakeUserRepo(),
      tokenRepo: fakeTokenRepo(),
      sendEmailVerificationEmail: async (to) => { sentTo.push(to); },
      webAppBaseUrl: 'http://localhost:5173',
    });
    assert.deepEqual(sentTo, []);
  });

  it('is a silent no-op for an already-verified account', async () => {
    const user: AuthUser = { id: 'user-1', primaryProvider: 'EMAIL', primaryProviderLogin: 'Jane', email: 'jane@example.com', emailVerifiedAt: new Date().toISOString() };
    const sentTo: string[] = [];
    await resendVerificationEmail('jane@example.com', {
      userRepo: fakeUserRepo({ findByEmail: async () => user }),
      tokenRepo: fakeTokenRepo(),
      sendEmailVerificationEmail: async (to) => { sentTo.push(to); },
      webAppBaseUrl: 'http://localhost:5173',
    });
    assert.deepEqual(sentTo, []);
  });
});
