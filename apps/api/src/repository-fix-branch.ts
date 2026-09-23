/**
 * Deterministic, safe branch-name generation for Phase 12's AI-fix Git
 * workflow. NEVER uses an arbitrary client-provided string directly as a
 * branch name — only a server-controlled findingId (already a trusted,
 * server-loaded identifier — see repository-fix-workflow-service.ts) and a
 * slug DERIVED FROM (not equal to) the finding's title, put through the
 * same sanitize-then-validate discipline as every other untrusted-string
 * boundary in this project (compare repository-path-safety.ts).
 */

const MAX_BRANCH_LENGTH = 100;
const MAX_SLUG_WORDS = 6;
const FINDING_ID_PREFIX_LENGTH = 8;

/**
 * git-check-ref-format's rules, the parts relevant to a single-segment
 * `ai-fix/<rest>` branch name: no ASCII control characters, no space, no
 * `~^:?*[\`, no consecutive dots, no leading/trailing dot or slash, no
 * trailing `.lock`, no `@{`, and — checked separately below — never starts
 * with `-` (which some Git plumbing would otherwise parse as an option).
 */
const GIT_REF_UNSAFE_CHARS = /[\x00-\x1f\x7f ~^:?*[\\]/g;

/** Lowercases, strips anything not alphanumeric/space/hyphen, collapses whitespace to single hyphens, and bounds word count — deterministic and safe regardless of what the AI/finding title contains (emoji, punctuation, markup, other scripts all collapse to nothing rather than leaking through). */
function slugifyTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS);
  return words.join('-');
}

/**
 * Builds `ai-fix/<finding-short-id>-<slug>`, then defensively re-sanitizes
 * and bounds the WHOLE result (not just the slug half) so a pathological
 * findingId can never smuggle an unsafe branch name through either.
 */
export function buildFixBranchName(findingId: string, title: string, suffix?: number): string {
  const shortId = findingId.replace(/[^a-zA-Z0-9]/g, '').slice(0, FINDING_ID_PREFIX_LENGTH).toLowerCase() || 'finding';
  const slug = slugifyTitle(title) || 'fix';
  const suffixPart = suffix && suffix > 1 ? `-${suffix}` : '';

  let branch = `ai-fix/${shortId}-${slug}`;
  const budget = MAX_BRANCH_LENGTH - suffixPart.length;
  if (branch.length > budget) branch = branch.slice(0, budget).replace(/-+$/, '');
  branch = `${branch}${suffixPart}`;

  return sanitizeBranchName(branch);
}

/** Strips/collapses anything git-check-ref-format would reject, and never lets the result start with `-` (parsed as a CLI flag by some Git subcommands) or `.`. Idempotent — safe to call on an already-generated name (defense in depth) or on any other candidate branch name. */
export function sanitizeBranchName(raw: string): string {
  let name = raw
    .replace(GIT_REF_UNSAFE_CHARS, '-')
    .replace(/\.\.+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+/, '')
    .replace(/[-./]+$/, '')
    .replace(/\.lock$/i, '-lock')
    .replace(/@\{/g, '-')
    .slice(0, MAX_BRANCH_LENGTH);

  if (!name) name = 'ai-fix/fix';
  return name;
}

const VALID_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/;

/**
 * Final validation gate before a branch name is ever passed to `git` —
 * independent of (and stricter than) the generator above, so a hand-built
 * or previously-persisted branch name is always re-checked rather than
 * trusted. Deliberately conservative: single-character names, names with
 * `..`, `//`, a leading/trailing `.`/`/`/`-`, or characters outside the
 * allowlist are all rejected.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > MAX_BRANCH_LENGTH) return false;
  if (name.startsWith('-')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.endsWith('.lock')) return false;
  if (name.includes('@{')) return false;
  return VALID_BRANCH_NAME.test(name);
}
