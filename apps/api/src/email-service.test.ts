import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  sendPasswordResetEmail,
  sendWorkspaceInvitationEmail,
  sendPasswordChangedEmail,
  sendWorkspaceMemberAddedEmail,
  sendWorkspaceMemberRemovedEmail,
  sendRepositoryConnectedEmail,
  sendPullRequestCreatedEmail,
  sendEmailVerificationEmail,
  sendRepositoryIndexCompletedEmail,
  sendRepositoryIndexFailedEmail,
  sendBillingPlanLimitReachedEmail,
  sendBillingPlanExpiringSoonEmail,
} from './email-service.js';

const SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;
const original = Object.fromEntries(SMTP_VARS.map((k) => [k, process.env[k]]));

function clearSmtpEnv(): void {
  for (const key of SMTP_VARS) delete process.env[key];
}

afterEach(() => {
  for (const key of SMTP_VARS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('email-service — configuration', () => {
  it('isEmailConfigured is false when no SMTP env vars are set', () => {
    clearSmtpEnv();
    assert.equal(isEmailConfigured(), false);
  });

  it('isEmailConfigured is false when only some SMTP env vars are set', () => {
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    assert.equal(isEmailConfigured(), false);
  });

  it('isEmailConfigured is true once all required SMTP env vars are set', () => {
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASSWORD = 'pass';
    process.env.SMTP_FROM = 'Origami Lens <noreply@example.com>';
    assert.equal(isEmailConfigured(), true);
  });

  it('sendPasswordResetEmail throws EmailNotConfiguredError (never silently pretends to send) when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendPasswordResetEmail('jane@example.com', 'http://localhost:5173/reset-password?token=abc'),
      EmailNotConfiguredError,
    );
  });

  it('isEmailConfigured is false for a non-numeric or zero SMTP_PORT', () => {
    clearSmtpEnv();
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = 'not-a-number';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASSWORD = 'pass';
    process.env.SMTP_FROM = 'noreply@example.com';
    assert.equal(isEmailConfigured(), false);
  });
});

describe('sendWorkspaceInvitationEmail', () => {
  it('throws EmailNotConfiguredError (never silently pretends to send) when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () =>
        sendWorkspaceInvitationEmail('jane@example.com', {
          workspaceName: 'Acme Workspace',
          inviterName: 'Alice',
          role: 'MEMBER',
          url: 'http://localhost:5173/invitations/abc',
          expiresAt: new Date().toISOString(),
        }),
      EmailNotConfiguredError,
    );
  });
});

describe('new senders — same fail-fast contract as the two original senders', () => {
  it('sendPasswordChangedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendPasswordChangedEmail('jane@example.com', { changedAt: new Date().toISOString(), webAppBaseUrl: 'http://localhost:5173' }),
      EmailNotConfiguredError,
    );
  });

  it('sendWorkspaceMemberAddedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () =>
        sendWorkspaceMemberAddedEmail('jane@example.com', {
          workspaceName: 'Acme Workspace',
          role: 'MEMBER',
          webAppBaseUrl: 'http://localhost:5173',
        }),
      EmailNotConfiguredError,
    );
  });

  it('sendWorkspaceMemberRemovedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendWorkspaceMemberRemovedEmail('jane@example.com', { workspaceName: 'Acme Workspace' }),
      EmailNotConfiguredError,
    );
  });

  it('sendRepositoryConnectedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () =>
        sendRepositoryConnectedEmail('jane@example.com', {
          repoName: 'facebook/react',
          role: 'FRONTEND',
          repositoryId: 'repo-1',
          webAppBaseUrl: 'http://localhost:5173',
        }),
      EmailNotConfiguredError,
    );
  });

  it('sendPullRequestCreatedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () =>
        sendPullRequestCreatedEmail('jane@example.com', {
          repoName: 'facebook/react',
          findingTitle: 'Missing null check',
          prNumber: 1,
          prUrl: 'https://github.com/facebook/react/pull/1',
          branchName: 'origami-lens/fix-1',
        }),
      EmailNotConfiguredError,
    );
  });

  it('sendEmailVerificationEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendEmailVerificationEmail('jane@example.com', { verificationUrl: 'http://localhost:5173/verify-email?token=abc' }),
      EmailNotConfiguredError,
    );
  });

  it('sendRepositoryIndexCompletedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendRepositoryIndexCompletedEmail('jane@example.com', { repoName: 'facebook/react', repositoryId: 'repo-1', webAppBaseUrl: 'http://localhost:5173' }),
      EmailNotConfiguredError,
    );
  });

  it('sendRepositoryIndexFailedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendRepositoryIndexFailedEmail('jane@example.com', { repoName: 'facebook/react', repositoryId: 'repo-1', webAppBaseUrl: 'http://localhost:5173' }),
      EmailNotConfiguredError,
    );
  });

  it('sendBillingPlanLimitReachedEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () => sendBillingPlanLimitReachedEmail('jane@example.com', { plan: 'FREE', webAppBaseUrl: 'http://localhost:5173' }),
      EmailNotConfiguredError,
    );
  });

  it('sendBillingPlanExpiringSoonEmail throws EmailNotConfiguredError when SMTP is unset', async () => {
    clearSmtpEnv();
    await assert.rejects(
      () =>
        sendBillingPlanExpiringSoonEmail('jane@example.com', {
          plan: 'TEAM',
          currentPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          webAppBaseUrl: 'http://localhost:5173',
        }),
      EmailNotConfiguredError,
    );
  });
});
