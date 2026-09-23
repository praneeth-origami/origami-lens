/**
 * Barrel + dev-preview registry. DEV_EMAIL_PREVIEWS renders every template
 * against fixture data (never real DB rows) — the only thing index.ts's
 * dev-only /dev/emails routes need to import.
 */
import { renderWorkspaceInvitationEmail } from './workspace-invitation.js';
import { renderPasswordResetEmail } from './password-reset.js';
import { renderPasswordChangedEmail } from './password-changed.js';
import { renderEmailVerificationEmail } from './email-verification.js';
import { renderWorkspaceMemberAddedEmail } from './workspace-member-added.js';
import { renderWorkspaceMemberRemovedEmail } from './workspace-member-removed.js';
import { renderRepositoryConnectedEmail } from './repository-connected.js';
import { renderRepositoryIndexCompletedEmail } from './repository-index-completed.js';
import { renderRepositoryIndexFailedEmail } from './repository-index-failed.js';
import { renderPullRequestCreatedEmail } from './pull-request-created.js';
import { renderBillingSubscriptionStartedEmail } from './billing-subscription-started.js';
import { renderBillingPaymentSuccessfulEmail } from './billing-payment-successful.js';
import { renderBillingPaymentFailedEmail } from './billing-payment-failed.js';
import { renderBillingPlanLimitReachedEmail } from './billing-plan-limit-reached.js';
import { renderBillingSubscriptionCancelledEmail } from './billing-subscription-cancelled.js';
import { renderBillingPlanExpiringSoonEmail } from './billing-plan-expiring-soon.js';

export * from './workspace-invitation.js';
export * from './password-reset.js';
export * from './password-changed.js';
export * from './email-verification.js';
export * from './workspace-member-added.js';
export * from './workspace-member-removed.js';
export * from './repository-connected.js';
export * from './repository-index-completed.js';
export * from './repository-index-failed.js';
export * from './pull-request-created.js';
export * from './billing-subscription-started.js';
export * from './billing-payment-successful.js';
export * from './billing-payment-failed.js';
export * from './billing-plan-limit-reached.js';
export * from './billing-subscription-cancelled.js';
export * from './billing-plan-expiring-soon.js';

const SAMPLE_WEB_APP_BASE_URL = 'http://localhost:5173';
const SAMPLE_EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

/** name -> renderer, each called with realistic fixture data. Ordering here is the ordering shown on the /dev/emails index page. */
export const DEV_EMAIL_PREVIEWS: Record<string, () => { subject: string; html: string; text: string }> = {
  'workspace-invitation': () =>
    renderWorkspaceInvitationEmail({
      workspaceName: 'Acme Corp',
      inviterName: 'Priya Sharma',
      role: 'ADMIN',
      url: `${SAMPLE_WEB_APP_BASE_URL}/invitations/sample-token`,
      expiresAt: SAMPLE_EXPIRES_AT,
    }),
  'password-reset': () => renderPasswordResetEmail({ resetUrl: `${SAMPLE_WEB_APP_BASE_URL}/reset-password?token=sample-token` }),
  'password-changed': () => renderPasswordChangedEmail({ changedAt: new Date().toISOString(), webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL }),
  'email-verification': () => renderEmailVerificationEmail({ verificationUrl: `${SAMPLE_WEB_APP_BASE_URL}/verify-email?token=sample-token` }),
  'workspace-member-added': () =>
    renderWorkspaceMemberAddedEmail({ workspaceName: 'Acme Corp', role: 'MEMBER', webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL }),
  'workspace-member-removed': () => renderWorkspaceMemberRemovedEmail({ workspaceName: 'Acme Corp' }),
  'repository-connected': () =>
    renderRepositoryConnectedEmail({
      repoName: 'facebook/react',
      role: 'FRONTEND',
      repositoryId: 'sample-repo-id',
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
    }),
  'repository-index-completed': () =>
    renderRepositoryIndexCompletedEmail({
      repoName: 'facebook/react',
      repositoryId: 'sample-repo-id',
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
      filesIndexed: 842,
      chunksCreated: 3190,
    }),
  'repository-index-failed': () =>
    renderRepositoryIndexFailedEmail({
      repoName: 'facebook/react',
      repositoryId: 'sample-repo-id',
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
      errorMessage: "Branch 'main' does not exist on this repository.",
    }),
  'pull-request-created': () =>
    renderPullRequestCreatedEmail({
      repoName: 'facebook/react',
      findingTitle: 'Missing null check in useEffect cleanup',
      prNumber: 482,
      prUrl: 'https://github.com/facebook/react/pull/482',
      branchName: 'origami-lens/fix-null-check-482',
    }),
  'billing-subscription-started': () =>
    renderBillingSubscriptionStartedEmail({
      plan: 'TEAM',
      seatCount: 5,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
    }),
  'billing-payment-successful': () =>
    renderBillingPaymentSuccessfulEmail({ amount: '$49.00', plan: 'TEAM', webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL }),
  'billing-payment-failed': () => renderBillingPaymentFailedEmail({ plan: 'TEAM', webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL }),
  'billing-plan-limit-reached': () =>
    renderBillingPlanLimitReachedEmail({
      plan: 'FREE',
      resource: 'Scans this month',
      resetAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
    }),
  'billing-subscription-cancelled': () =>
    renderBillingSubscriptionCancelledEmail({
      plan: 'TEAM',
      effectiveAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
    }),
  'billing-plan-expiring-soon': () =>
    renderBillingPlanExpiringSoonEmail({
      plan: 'TEAM',
      currentPeriodEnd: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      webAppBaseUrl: SAMPLE_WEB_APP_BASE_URL,
    }),
};
