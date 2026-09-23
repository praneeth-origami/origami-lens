/**
 * Outbound email — SMTP only (nodemailer), configured entirely via env vars.
 * No provider-specific SDK, so any real SMTP endpoint works (Gmail, SES,
 * Mailgun, a self-hosted relay, etc.) without a code change. There is
 * deliberately no fallback/mock "pretend it sent" path — see
 * EmailNotConfiguredError's callers in password-auth-service.ts, which
 * catch this specifically so the CALLER (forgot-password) can still return
 * its normal generic response while logging the real cause server-side.
 *
 * HTML/text bodies are built by the branded template system in email/ —
 * this file stays the single place that knows how to actually deliver a
 * message (transport, SMTP config, the logo attachment), one thin
 * `sendXEmail` wrapper per template.
 */
import nodemailer from 'nodemailer';
import { loadLogoAttachment } from './email/layout.js';
import { renderWorkspaceInvitationEmail, type WorkspaceInvitationEmailData } from './email/templates/workspace-invitation.js';
import { renderPasswordResetEmail } from './email/templates/password-reset.js';
import { renderPasswordChangedEmail, type PasswordChangedEmailData } from './email/templates/password-changed.js';
import { renderWorkspaceMemberAddedEmail, type WorkspaceMemberAddedEmailData } from './email/templates/workspace-member-added.js';
import { renderWorkspaceMemberRemovedEmail, type WorkspaceMemberRemovedEmailData } from './email/templates/workspace-member-removed.js';
import { renderRepositoryConnectedEmail, type RepositoryConnectedEmailData } from './email/templates/repository-connected.js';
import { renderPullRequestCreatedEmail, type PullRequestCreatedEmailData } from './email/templates/pull-request-created.js';
import { renderEmailVerificationEmail, type EmailVerificationEmailData } from './email/templates/email-verification.js';
import { renderRepositoryIndexCompletedEmail, type RepositoryIndexCompletedEmailData } from './email/templates/repository-index-completed.js';
import { renderRepositoryIndexFailedEmail, type RepositoryIndexFailedEmailData } from './email/templates/repository-index-failed.js';
import { renderBillingSubscriptionStartedEmail, type BillingSubscriptionStartedEmailData } from './email/templates/billing-subscription-started.js';
import { renderBillingPaymentSuccessfulEmail, type BillingPaymentSuccessfulEmailData } from './email/templates/billing-payment-successful.js';
import { renderBillingPaymentFailedEmail, type BillingPaymentFailedEmailData } from './email/templates/billing-payment-failed.js';
import { renderBillingPlanLimitReachedEmail, type BillingPlanLimitReachedEmailData } from './email/templates/billing-plan-limit-reached.js';
import { renderBillingSubscriptionCancelledEmail, type BillingSubscriptionCancelledEmailData } from './email/templates/billing-subscription-cancelled.js';
import { renderBillingPlanExpiringSoonEmail, type BillingPlanExpiringSoonEmailData } from './email/templates/billing-plan-expiring-soon.js';

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email sending is not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM).');
    this.name = 'EmailNotConfiguredError';
  }
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

function getSmtpConfig(): SmtpConfig | undefined {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.trim();
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !Number.isFinite(port) || port <= 0 || !user || !password || !from) return undefined;
  return { host, port, user, password, from };
}

export function isEmailConfigured(): boolean {
  return getSmtpConfig() !== undefined;
}

/** One transport per call — SMTP config is read fresh every time (same convention as this codebase's other env-driven config, e.g. github-app-auth.ts), never cached at module load, so a config change takes effect without a restart in tests. */
function buildTransport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });
}

/** Shared by every sendXEmail below: builds the transport, attaches the cid-embedded logo (skipped if it can't be read), sends. Throws EmailNotConfiguredError (before touching the network) or the transport's own rejection, exactly as this file always has. */
async function deliverEmail(to: string, message: { subject: string; html: string; text: string }): Promise<void> {
  const config = getSmtpConfig();
  if (!config) throw new EmailNotConfiguredError();

  const logo = await loadLogoAttachment();
  const transport = buildTransport(config);
  await transport.sendMail({
    from: config.from,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: logo ? [{ filename: logo.filename, content: logo.content, cid: logo.cid }] : undefined,
  });
}

/** Kept as a named export for existing imports (workspace-invitation-service.ts) — same shape as the template's own data contract. */
export type WorkspaceInvitationEmailInput = WorkspaceInvitationEmailData;

export async function sendWorkspaceInvitationEmail(to: string, input: WorkspaceInvitationEmailInput): Promise<void> {
  await deliverEmail(to, renderWorkspaceInvitationEmail(input));
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await deliverEmail(to, renderPasswordResetEmail({ resetUrl }));
}

export async function sendPasswordChangedEmail(to: string, data: PasswordChangedEmailData): Promise<void> {
  await deliverEmail(to, renderPasswordChangedEmail(data));
}

export async function sendWorkspaceMemberAddedEmail(to: string, data: WorkspaceMemberAddedEmailData): Promise<void> {
  await deliverEmail(to, renderWorkspaceMemberAddedEmail(data));
}

export async function sendWorkspaceMemberRemovedEmail(to: string, data: WorkspaceMemberRemovedEmailData): Promise<void> {
  await deliverEmail(to, renderWorkspaceMemberRemovedEmail(data));
}

export async function sendRepositoryConnectedEmail(to: string, data: RepositoryConnectedEmailData): Promise<void> {
  await deliverEmail(to, renderRepositoryConnectedEmail(data));
}

export async function sendPullRequestCreatedEmail(to: string, data: PullRequestCreatedEmailData): Promise<void> {
  await deliverEmail(to, renderPullRequestCreatedEmail(data));
}

export async function sendEmailVerificationEmail(to: string, data: EmailVerificationEmailData): Promise<void> {
  await deliverEmail(to, renderEmailVerificationEmail(data));
}

export async function sendRepositoryIndexCompletedEmail(to: string, data: RepositoryIndexCompletedEmailData): Promise<void> {
  await deliverEmail(to, renderRepositoryIndexCompletedEmail(data));
}

export async function sendRepositoryIndexFailedEmail(to: string, data: RepositoryIndexFailedEmailData): Promise<void> {
  await deliverEmail(to, renderRepositoryIndexFailedEmail(data));
}

export async function sendBillingSubscriptionStartedEmail(to: string, data: BillingSubscriptionStartedEmailData): Promise<void> {
  await deliverEmail(to, renderBillingSubscriptionStartedEmail(data));
}

export async function sendBillingPaymentSuccessfulEmail(to: string, data: BillingPaymentSuccessfulEmailData): Promise<void> {
  await deliverEmail(to, renderBillingPaymentSuccessfulEmail(data));
}

export async function sendBillingPaymentFailedEmail(to: string, data: BillingPaymentFailedEmailData): Promise<void> {
  await deliverEmail(to, renderBillingPaymentFailedEmail(data));
}

export async function sendBillingPlanLimitReachedEmail(to: string, data: BillingPlanLimitReachedEmailData): Promise<void> {
  await deliverEmail(to, renderBillingPlanLimitReachedEmail(data));
}

export async function sendBillingSubscriptionCancelledEmail(to: string, data: BillingSubscriptionCancelledEmailData): Promise<void> {
  await deliverEmail(to, renderBillingSubscriptionCancelledEmail(data));
}

export async function sendBillingPlanExpiringSoonEmail(to: string, data: BillingPlanExpiringSoonEmailData): Promise<void> {
  await deliverEmail(to, renderBillingPlanExpiringSoonEmail(data));
}
