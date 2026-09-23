import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escape.js';
import { DEV_EMAIL_PREVIEWS } from './templates/index.js';
import { renderWorkspaceInvitationEmail } from './templates/workspace-invitation.js';
import { renderWorkspaceMemberAddedEmail } from './templates/workspace-member-added.js';
import { renderWorkspaceMemberRemovedEmail } from './templates/workspace-member-removed.js';
import { renderRepositoryConnectedEmail } from './templates/repository-connected.js';
import { renderPullRequestCreatedEmail } from './templates/pull-request-created.js';
import { EMAIL_SUBJECTS } from './subjects.js';

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    assert.equal(escapeHtml(`<script>alert('x')</script> & "quoted"`), '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quoted&quot;');
  });
});

describe('every template renders without throwing', () => {
  for (const name of Object.keys(DEV_EMAIL_PREVIEWS)) {
    it(`${name} renders valid subject/html/text`, () => {
      const { subject, html, text } = DEV_EMAIL_PREVIEWS[name]();
      assert.ok(subject.length > 0, 'subject must be non-empty');
      assert.ok(html.includes('<!DOCTYPE html>'), 'html must be a full document');
      assert.ok(html.includes('cid:origami-lens-logo'), 'html must reference the embedded logo');
      assert.ok(text.length > 0, 'text must be non-empty');
    });
  }
});

describe('plain-text fallbacks contain no HTML tags', () => {
  for (const name of Object.keys(DEV_EMAIL_PREVIEWS)) {
    it(`${name} text has no markup`, () => {
      const { text } = DEV_EMAIL_PREVIEWS[name]();
      assert.doesNotMatch(text, /<[a-z][^>]*>/i);
    });
  }
});

describe('user-controlled strings are escaped, not injected raw', () => {
  const injected = `<img src=x onerror=alert(1)>`;

  it('workspace-invitation escapes inviterName and workspaceName', () => {
    const { html } = renderWorkspaceInvitationEmail({
      workspaceName: injected,
      inviterName: injected,
      role: 'MEMBER',
      url: 'http://localhost:5173/invitations/abc',
      expiresAt: new Date().toISOString(),
    });
    assert.ok(!html.includes(injected));
    assert.ok(html.includes(escapeHtml(injected)));
  });

  it('workspace-member-added escapes workspaceName', () => {
    const { html } = renderWorkspaceMemberAddedEmail({ workspaceName: injected, role: 'MEMBER', webAppBaseUrl: 'http://localhost:5173' });
    assert.ok(!html.includes(injected));
  });

  it('workspace-member-removed escapes workspaceName', () => {
    const { html } = renderWorkspaceMemberRemovedEmail({ workspaceName: injected });
    assert.ok(!html.includes(injected));
  });

  it('repository-connected escapes repoName', () => {
    const { html } = renderRepositoryConnectedEmail({ repoName: injected, role: 'FRONTEND', repositoryId: 'r1', webAppBaseUrl: 'http://localhost:5173' });
    assert.ok(!html.includes(injected));
  });

  it('pull-request-created escapes repoName and findingTitle', () => {
    const { html } = renderPullRequestCreatedEmail({
      repoName: injected,
      findingTitle: injected,
      prNumber: 1,
      prUrl: 'https://github.com/example/repo/pull/1',
      branchName: 'origami-lens/fix-1',
    });
    assert.ok(!html.includes(injected));
  });
});

describe('EMAIL_SUBJECTS matches what each template actually renders', () => {
  it('workspace-invitation subject matches EMAIL_SUBJECTS.workspaceInvitation', () => {
    const { subject } = renderWorkspaceInvitationEmail({
      workspaceName: 'Acme Corp',
      inviterName: 'Priya',
      role: 'MEMBER',
      url: 'http://localhost:5173/invitations/abc',
      expiresAt: new Date().toISOString(),
    });
    assert.equal(subject, EMAIL_SUBJECTS.workspaceInvitation('Acme Corp'));
  });

  it('workspace-member-removed subject matches EMAIL_SUBJECTS.workspaceMemberRemoved', () => {
    const { subject } = renderWorkspaceMemberRemovedEmail({ workspaceName: 'Acme Corp' });
    assert.equal(subject, EMAIL_SUBJECTS.workspaceMemberRemoved('Acme Corp'));
  });
});
