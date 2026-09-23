import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailBadge, emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface WorkspaceInvitationEmailData {
  workspaceName: string;
  inviterName: string;
  role: string;
  url: string;
  expiresAt: string;
}

export function renderWorkspaceInvitationEmail(data: WorkspaceInvitationEmailData): { subject: string; html: string; text: string } {
  const expiresLabel = new Date(data.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const bodyHtml = `
    <p>${escapeHtml(data.inviterName)} invited you to join <strong>${escapeHtml(data.workspaceName)}</strong> on Origami Lens.</p>
    <p>${emailBadge({ label: data.role, tone: 'info' })}</p>
    ${emailButton({ href: data.url, label: 'Accept invitation' })}
    ${emailMetadataRow({ label: 'Expires', value: expiresLabel })}
    <p style="color:#667085;font-size:13px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
  `;

  const text = [
    `${data.inviterName} invited you to join ${data.workspaceName} on Origami Lens.`,
    `Role: ${data.role}`,
    `Accept your invitation: ${data.url}`,
    `This invitation expires on ${expiresLabel}.`,
    `If you weren't expecting this invitation, you can safely ignore this email.`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.workspaceInvitation(data.workspaceName),
    html: renderEmailLayout({ previewText: `${data.inviterName} invited you to join ${data.workspaceName}`, bodyHtml }),
    text,
  };
}
