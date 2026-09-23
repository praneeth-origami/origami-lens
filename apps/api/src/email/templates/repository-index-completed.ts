import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

/**
 * Built and previewable, but NOT wired to a real trigger — repository-index-worker.ts's
 * RepositoryIndexJobPayload carries no organization/user email context today
 * (only jobId/repositoryId/cloneJobId/ownerId, and ownerId is never read
 * inside finalize()). Wiring a real send means widening that queue payload
 * contract, a worker-architecture change beyond what an email-template task
 * should touch.
 */
export interface RepositoryIndexCompletedEmailData {
  repoName: string;
  repositoryId: string;
  webAppBaseUrl: string;
  filesIndexed?: number;
  chunksCreated?: number;
}

export function renderRepositoryIndexCompletedEmail(data: RepositoryIndexCompletedEmailData): { subject: string; html: string; text: string } {
  const repoUrl = `${data.webAppBaseUrl}/repositories/${data.repositoryId}`;
  const metaRows = [
    data.filesIndexed !== undefined ? emailMetadataRow({ label: 'Files indexed', value: String(data.filesIndexed) }) : '',
    data.chunksCreated !== undefined ? emailMetadataRow({ label: 'Chunks created', value: String(data.chunksCreated) }) : '',
  ].join('');
  const bodyHtml = `
    <p><strong>${escapeHtml(data.repoName)}</strong> has finished indexing and is ready to search.</p>
    ${metaRows}
    ${emailButton({ href: repoUrl, label: 'View repository' })}
  `;

  const text = [
    `${data.repoName} has finished indexing and is ready to search.`,
    data.filesIndexed !== undefined ? `Files indexed: ${data.filesIndexed}` : '',
    data.chunksCreated !== undefined ? `Chunks created: ${data.chunksCreated}` : '',
    `View repository: ${repoUrl}`,
  ].filter(Boolean).join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.repositoryIndexCompleted(data.repoName),
    html: renderEmailLayout({ previewText: `${data.repoName} is ready to search`, bodyHtml }),
    text,
  };
}
