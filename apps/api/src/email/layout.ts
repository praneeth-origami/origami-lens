/**
 * Shared table-based, inline-styled HTML shell used by every template in
 * email/templates/*.ts. Hardcodes the same brand tokens apps/web/src/styles/dashboard.css
 * defines as CSS custom properties (:root) — email clients don't evaluate
 * custom properties, so they're duplicated here as literal values rather
 * than shared at runtime.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { escapeHtml } from './escape.js';

export const BRAND = {
  primary: '#6d5ef6',
  success: '#16a34a',
  successSubtle: 'rgba(22,163,74,0.12)',
  warning: '#d97706',
  warningSubtle: 'rgba(217,119,6,0.12)',
  danger: '#dc2626',
  dangerSubtle: 'rgba(220,38,38,0.1)',
  info: '#2563eb',
  infoSubtle: 'rgba(37,99,235,0.12)',
  text: '#111827',
  textSecondary: '#475467',
  textMuted: '#667085',
  border: '#dfe7f1',
  surface: '#ffffff',
  background: '#f4f7fb',
  font: `'Segoe UI', Helvetica, Arial, sans-serif`,
  fontMono: `ui-monospace, 'Cascadia Code', 'SF Mono', Consolas, monospace`,
} as const;

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * apps/web/public/brand-icon.png is the only rendering of the Origami Lens
 * mark anywhere in the repo — no SVG exists, and no publicly reachable URL
 * exists for it (the API serves no static files; WEB_APP_BASE_URL resolves
 * to a bare localhost origin in dev). Emails therefore embed it as a `cid:`
 * attachment via nodemailer rather than linking to it, so it renders
 * identically regardless of where the recipient's mail client fetches from.
 * Read lazily (once, cached) rather than at module load so a missing file
 * never breaks the module graph — only the logo itself is skipped.
 */
const LOGO_PATH = path.resolve(here, '../../../../apps/web/public/brand-icon.png');
export const LOGO_CID = 'origami-lens-logo';

let cachedLogo: Buffer | null | undefined;

export async function loadLogoAttachment(): Promise<{ filename: string; content: Buffer; cid: string } | undefined> {
  if (cachedLogo === null) return undefined;
  if (cachedLogo) return { filename: 'origami-lens-logo.png', content: cachedLogo, cid: LOGO_CID };
  try {
    cachedLogo = await readFile(LOGO_PATH);
    return { filename: 'origami-lens-logo.png', content: cachedLogo, cid: LOGO_CID };
  } catch (error) {
    console.error('[email/layout] Could not read brand-icon.png for email embedding:', error instanceof Error ? error.message : error);
    cachedLogo = null;
    return undefined;
  }
}

/**
 * previewText is often built by callers from user-controlled strings
 * (display names, workspace names) via a plain template literal — this
 * function is the one place that escapes it, so no template needs to
 * remember to do so itself.
 */
export function renderEmailLayout(opts: { previewText: string; bodyHtml: string }): string {
  const { previewText, bodyHtml } = opts;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Origami Lens</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.background};font-family:${BRAND.font};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(previewText)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.background};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.surface};border-radius:12px;overflow:hidden;border:1px solid ${BRAND.border};">
            <tr>
              <td style="padding:28px 32px;border-bottom:1px solid ${BRAND.border};">
                <img src="cid:${LOGO_CID}" width="28" height="28" alt="Origami Lens" style="vertical-align:middle;border-radius:6px;" />
                <span style="vertical-align:middle;padding-left:10px;font-size:16px;font-weight:600;color:${BRAND.text};">Origami Lens</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;color:${BRAND.text};font-size:15px;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid ${BRAND.border};color:${BRAND.textMuted};font-size:12px;line-height:1.6;">
                You're receiving this email because of activity on your Origami Lens account.<br />
                &copy; ${new Date().getFullYear()} Origami Lens. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
