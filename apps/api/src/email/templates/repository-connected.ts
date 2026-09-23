import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface RepositoryConnectedEmailData {
  repoName: string;
  role: string;
  repositoryId: string;
  webAppBaseUrl: string;
}

export function renderRepositoryConnectedEmail(data: RepositoryConnectedEmailData): { subject: string; html: string; text: string } {
  const repoUrl = `${data.webAppBaseUrl}/repositories/${data.repositoryId}`;
  const bodyHtml = `
    <p><strong>${escapeHtml(data.repoName)}</strong> is now connected to Origami Lens and will be indexed for search and analysis.</p>
    ${emailMetadataRow({ label: 'Role', value: data.role })}
    ${emailButton({ href: repoUrl, label: 'View repository' })}
  `;

  const text = [
    `${data.repoName} is now connected to Origami Lens and will be indexed for search and analysis.`,
    `Role: ${data.role}`,
    `View repository: ${repoUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.repositoryConnected(data.repoName),
    html: renderEmailLayout({ previewText: `${data.repoName} is connected`, bodyHtml }),
    text,
  };
}
