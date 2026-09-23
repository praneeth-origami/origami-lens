/** Single source of truth for email normalization — used by password auth and workspace invitations so the same address always resolves to the same identity regardless of casing/whitespace. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
