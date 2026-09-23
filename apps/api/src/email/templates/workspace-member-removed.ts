import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface WorkspaceMemberRemovedEmailData {
  workspaceName: string;
}

export function renderWorkspaceMemberRemovedEmail(data: WorkspaceMemberRemovedEmailData): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <p>You've been removed from <strong>${escapeHtml(data.workspaceName)}</strong> on Origami Lens and no longer have access to it.</p>
    <p style="color:#667085;font-size:13px;">If you think this was a mistake, contact the workspace's owner or admin.</p>
  `;

  const text = [
    `You've been removed from ${data.workspaceName} on Origami Lens and no longer have access to it.`,
    'If you think this was a mistake, contact the workspace\'s owner or admin.',
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.workspaceMemberRemoved(data.workspaceName),
    html: renderEmailLayout({ previewText: `You've been removed from ${data.workspaceName}`, bodyHtml }),
    text,
  };
}
