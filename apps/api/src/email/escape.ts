/**
 * Every template must pass user-controlled strings (display names, workspace
 * names, repo names, finding titles, role labels) through this before
 * interpolating them into HTML — the previous inline-template-literal emails
 * (email-service.ts, pre-rewrite) never escaped anything, so a workspace name
 * or display name containing markup could inject content into a recipient's
 * inbox. Plain-text bodies never need this — text/plain has no markup to break.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
