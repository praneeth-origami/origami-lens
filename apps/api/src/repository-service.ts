import type { RepositoryProvider } from '@origami/contracts';

/**
 * Exact-hostname allowlist (not a blocklist of "bad" hosts) — this is what
 * actually makes this SSRF-safe: localhost, 127.0.0.1, private IPs,
 * file://, arbitrary internal/external hosts, and lookalike domains
 * (e.g. github.com.attacker.com, whose hostname is NOT "github.com") are
 * all rejected automatically by simply not being in this map, with no
 * separate IP-range/protocol denylist needed.
 */
const SUPPORTED_HOSTS: Record<string, RepositoryProvider> = {
  'github.com': 'GITHUB',
  'gitlab.com': 'GITLAB',
  'bitbucket.org': 'BITBUCKET',
};

/** Conservative safe charset for an owner/repo path segment — defense in depth beyond the hostname allowlist. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Git branch names are more permissive (slashes for hierarchical names like feature/x) but still bounded and printable-only. */
const SAFE_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
const MAX_BRANCH_LENGTH = 255;

export const DEFAULT_BRANCH = 'main';

export interface ParsedRepositoryUrl {
  /** Always https://<host>/<owner>/<repo> — no .git suffix, no trailing slash, no query/hash, no embedded credentials. */
  normalizedUrl: string;
  provider: RepositoryProvider;
  owner: string;
  name: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates and normalizes a repository URL. HTTPS + exact-host-allowlist
 * only (github.com / gitlab.com / bitbucket.org) — see SUPPORTED_HOSTS for
 * why this alone is the SSRF defense, not a separate private-IP check.
 * Rejects embedded credentials, non-HTTPS protocols (http/ssh/git/file),
 * non-standard ports, and anything that isn't exactly one owner + one repo
 * path segment.
 */
export function parseRepositoryUrl(rawUrl: string): ValidationResult<ParsedRepositoryUrl> {
  if (!rawUrl || !rawUrl.trim()) {
    return { ok: false, error: 'repoUrl is required' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'repoUrl is not a valid URL' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS repository URLs are supported (no http, ssh, git, or file URLs).' };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'repoUrl must not contain embedded credentials.' };
  }

  if (url.port) {
    return { ok: false, error: 'repoUrl must not specify a custom port.' };
  }

  const hostname = url.hostname.toLowerCase();
  const provider = SUPPORTED_HOSTS[hostname];
  if (!provider) {
    return { ok: false, error: 'repoUrl must be a github.com, gitlab.com, or bitbucket.org repository URL.' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return { ok: false, error: 'repoUrl must point directly to a repository, e.g. https://github.com/owner/repo.' };
  }

  const owner = segments[0];
  const name = segments[1].replace(/\.git$/i, '');
  if (!owner || !name || !SAFE_PATH_SEGMENT.test(owner) || !SAFE_PATH_SEGMENT.test(name)) {
    return { ok: false, error: 'repoUrl contains an invalid owner or repository name.' };
  }

  return {
    ok: true,
    value: { normalizedUrl: `https://${hostname}/${owner}/${name}`, provider, owner, name },
  };
}

/** Defaults to DEFAULT_BRANCH when omitted — a "branch required" API error would be unnecessarily strict for a well-known Git convention. */
export function validateBranch(rawBranch: string | undefined): ValidationResult<string> {
  if (rawBranch === undefined || rawBranch === null || rawBranch.trim() === '') {
    return { ok: true, value: DEFAULT_BRANCH };
  }
  const branch = rawBranch.trim();
  if (branch.length > MAX_BRANCH_LENGTH || !SAFE_BRANCH_NAME.test(branch)) {
    return { ok: false, error: 'branch contains invalid characters or is too long.' };
  }
  return { ok: true, value: branch };
}

/**
 * Real, strict ownership check (Phase 16/B) — replaces the pre-Phase-A
 * "allow if either side is missing" behavior now that both sides are
 * trustworthy: `repoOwnerId` is `repository.userId` (a real FK to `users`,
 * migration 012, set only from an authenticated request.user.id at
 * creation) and `requestOwnerId` is the CURRENT caller's request.user.id
 * (never client-supplied). A repository with no owner (a legacy
 * pre-Phase-16 row, user_id NULL) is therefore accessible to no one —
 * a deliberate tradeoff, not a bug (see the Phase 16 design report's
 * migration-strategy section). Every caller of this function must pass
 * `.userId`, never the legacy `.ownerId` field.
 */
export function canAccessRepository(repoOwnerId: string | undefined, requestOwnerId: string | undefined): boolean {
  return Boolean(repoOwnerId) && repoOwnerId === requestOwnerId;
}
