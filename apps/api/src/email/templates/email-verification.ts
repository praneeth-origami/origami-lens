import { renderEmailLayout } from '../layout.js';
import { emailButton } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Built and previewable per the spec's full template list, but NOT wired to
 * a real trigger — this app has no unverified-email gate anywhere (password
 * accounts aren't gated; OAuth accounts are provider-verified), so there is
 * no existing event that would call this. Adding that gate would be a new
 * auth requirement, out of scope for an email-template task.
 */
export interface EmailVerificationEmailData {
  verificationUrl: string;
}

export function renderEmailVerificationEmail(data: EmailVerificationEmailData): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <p>Confirm this is your email address to finish setting up your Origami Lens account.</p>
    ${emailButton({ href: data.verificationUrl, label: 'Verify email address' })}
    <p style="color:#667085;font-size:13px;">If you didn't create an Origami Lens account, you can safely ignore this email.</p>
  `;

  const text = [
    'Confirm this is your email address to finish setting up your Origami Lens account.',
    `Verify your email: ${data.verificationUrl}`,
    "If you didn't create an Origami Lens account, you can safely ignore this email.",
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.emailVerification,
    html: renderEmailLayout({ previewText: 'Verify your email address', bodyHtml }),
    text,
  };
}
