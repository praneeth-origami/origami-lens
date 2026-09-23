import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailButton, emailAlert } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/** Built and previewable, but NOT wired — see repository-index-completed.ts's doc comment for why (no email context in the worker's job payload today). */
export interface RepositoryIndexFailedEmailData {
  repoName: string;
  repositoryId: string;
  webAppBaseUrl: string;
  errorMessage?: string;
}

export function renderRepositoryIndexFailedEmail(data: RepositoryIndexFailedEmailData): { subject: string; html: string; text: string } {
  const repoUrl = `${data.webAppBaseUrl}/repositories/${data.repositoryId}`;
  const bodyHtml = `
    <p>Indexing failed for <strong>${escapeHtml(data.repoName)}</strong>.</p>
    ${emailAlert({ tone: 'danger', message: data.errorMessage ? escapeHtml(data.errorMessage) : 'An unexpected error occurred while indexing this repository.' })}
    ${emailButton({ href: repoUrl, label: 'View repository' })}
  `;

  const text = [
    `Indexing failed for ${data.repoName}.`,
    data.errorMessage ?? 'An unexpected error occurred while indexing this repository.',
    `View repository: ${repoUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.repositoryIndexFailed(data.repoName),
    html: renderEmailLayout({ previewText: `Indexing failed for ${data.repoName}`, bodyHtml }),
    text,
  };
}
