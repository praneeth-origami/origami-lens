import { escapeHtml } from './escape.js';
import { BRAND } from './layout.js';

export type EmailTone = 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<EmailTone, { color: string; subtle: string }> = {
  success: { color: BRAND.success, subtle: BRAND.successSubtle },
  warning: { color: BRAND.warning, subtle: BRAND.warningSubtle },
  danger: { color: BRAND.danger, subtle: BRAND.dangerSubtle },
  info: { color: BRAND.info, subtle: BRAND.infoSubtle },
};

export function emailButton(opts: { href: string; label: string }): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="border-radius:8px;background:${BRAND.primary};"><a href="${opts.href}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(opts.label)}</a></td></tr></table>`;
}

export function emailCard(bodyHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.background};border-radius:10px;margin:16px 0;"><tr><td style="padding:16px 20px;">${bodyHtml}</td></tr></table>`;
}

export function emailBadge(opts: { label: string; tone: EmailTone }): string {
  const { color, subtle } = TONE[opts.tone];
  return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${subtle};color:${color};font-size:12px;font-weight:600;">${escapeHtml(opts.label)}</span>`;
}

export function emailDivider(): string {
  return `<hr style="border:none;border-top:1px solid ${BRAND.border};margin:20px 0;" />`;
}

export function emailMetadataRow(opts: { label: string; value: string }): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0;"><tr><td style="padding:4px 0;color:${BRAND.textMuted};font-size:13px;">${escapeHtml(opts.label)}</td><td align="right" style="padding:4px 0;color:${BRAND.text};font-size:13px;font-family:${BRAND.fontMono};">${escapeHtml(opts.value)}</td></tr></table>`;
}

export function emailCodeBlock(code: string): string {
  return `<code style="display:block;padding:12px 14px;background:${BRAND.background};border:1px solid ${BRAND.border};border-radius:8px;font-family:${BRAND.fontMono};font-size:13px;color:${BRAND.text};word-break:break-all;">${escapeHtml(code)}</code>`;
}

export function emailAlert(opts: { tone: EmailTone; message: string }): string {
  const { color, subtle } = TONE[opts.tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td style="padding:12px 16px;background:${subtle};border-left:3px solid ${color};border-radius:6px;color:${BRAND.text};font-size:14px;">${escapeHtml(opts.message)}</td></tr></table>`;
}

export function emailStatus(opts: { tone: EmailTone; label: string }): string {
  const { color } = TONE[opts.tone];
  return `<span style="color:${color};font-size:13px;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;">${escapeHtml(opts.label)}</span>`;
}
