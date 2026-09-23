import { escapeHtml } from '../escape.js';
import { renderEmailLayout } from '../layout.js';
import { emailButton, emailMetadataRow, emailCodeBlock } from '../components.js';
import { EMAIL_SUBJECTS } from '../subjects.js';

export interface PullRequestCreatedEmailData {
  repoName: string;
  findingTitle: string;
  prNumber: number;
  prUrl: string;
  branchName: string;
}

export function renderPullRequestCreatedEmail(data: PullRequestCreatedEmailData): { subject: string; html: string; text: string } {
  const bodyHtml = `
    <p>Origami Lens opened a pull request for <strong>${escapeHtml(data.repoName)}</strong> to fix:</p>
    <p>${escapeHtml(data.findingTitle)}</p>
    ${emailMetadataRow({ label: 'Pull request', value: `#${data.prNumber}` })}
    ${emailCodeBlock(data.branchName)}
    ${emailButton({ href: data.prUrl, label: 'Review pull request' })}
  `;

  const text = [
    `Origami Lens opened a pull request for ${data.repoName} to fix:`,
    data.findingTitle,
    `Pull request: #${data.prNumber}`,
    `Branch: ${data.branchName}`,
    `Review it here: ${data.prUrl}`,
  ].join('\n\n');

  return {
    subject: EMAIL_SUBJECTS.pullRequestCreated(data.repoName),
    html: renderEmailLayout({ previewText: `PR #${data.prNumber} opened for ${data.repoName}`, bodyHtml }),
    text,
  };
}
