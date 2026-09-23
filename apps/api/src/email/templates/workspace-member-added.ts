import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailBadge, emailButton } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface WorkspaceMemberAddedEmailData {
  workspaceName: string;
  role: string;
  webAppBaseUrl: string;
}

export function renderWorkspaceMemberAddedEmail(data: WorkspaceMemberAddedEmailData): { subject: string; html: string; text: string } {
  const dashboardUrl = `${data.webAppBaseUrl}/workspace/members`;
  const bodyHtml = `
    <p>You've been added to <strong>${escapeHtml(data.workspaceName)}</strong> on Origami Lens.</p>
    <p>${emailBadge({ label: data.role, tone: 'info' })}</p>
    ${emailButton({ href: dashboardUrl, label: 'Go to workspace' })}
  `;

  const text = [
    `You've been added to ${data.workspaceName} on Origami Lens.`,
    `Role: ${data.role}`,
    `Go to workspace: ${dashboardUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.workspaceMemberAdded(data.workspaceName),
    html: renderEmailLayout({ previewText: `You've joined ${data.workspaceName}`, bodyHtml }),
    text,
  };
}
