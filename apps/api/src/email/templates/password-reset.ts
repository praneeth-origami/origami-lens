import { renderEmailLayout } from '../layout.js';
import { emailButton } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface PasswordResetEmailData {
  resetUrl: string;
}

export function renderPasswordResetEmail(data: PasswordResetEmailData): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <p>We received a request to reset your Origami Lens password.</p>
    ${emailButton({ href: data.resetUrl, label: 'Reset your password' })}
    <p style="color:#667085;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
  `;

  const text = [
    'We received a request to reset your Origami Lens password.',
    `Reset it here: ${data.resetUrl}`,
    'This link expires in 1 hour.',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.passwordReset,
    html: renderEmailLayout({ previewText: 'Reset your Origami Lens password', bodyHtml }),
    text,
  };
}
