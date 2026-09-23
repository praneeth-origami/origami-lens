import { renderEmailLayout } from '../layout.js';
import { emailButton, emailAlert } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface PasswordChangedEmailData {
  changedAt: string;
  webAppBaseUrl: string;
}

export function renderPasswordChangedEmail(data: PasswordChangedEmailData): { subject: string; html: string; text: string } {
  const changedLabel = new Date(data.changedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const resetUrl = `${data.webAppBaseUrl}/forgot-password`;
  const bodyHtml = `
    <p>Your Origami Lens password was changed on <strong>${changedLabel}</strong>.</p>
    ${emailAlert({ tone: 'warning', message: "If you didn't make this change, reset your password immediately." })}
    ${emailButton({ href: resetUrl, label: 'Reset your password' })}
  `;

  const text = [
    `Your Origami Lens password was changed on ${changedLabel}.`,
    "If you didn't make this change, reset your password immediately:",
    resetUrl,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.passwordChanged,
    html: renderEmailLayout({ previewText: 'Your password was changed', bodyHtml }),
    text,
  };
}
