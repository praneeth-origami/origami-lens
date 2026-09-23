import { execFile } from 'node:child_process';

/**
 * Every Git invocation in this module goes through this one function, and
 * every call site passes `file` + `args` as a literal command name plus an
 * argv array — never a single interpolated string, and `shell` is never set
 * to true (execFile defaults to false, and this file must never override
 * that). Repository URL and branch name are untrusted input; passing them as
 * discrete argv elements means shell metacharacters in either one (`;`, `$()`,
 * backticks, `&&`, ...) are inert — the OS passes them to git as literal
 * argument bytes, never through a shell that could interpret them.
 */
function run(args: string[], opts: { signal?: AbortSignal; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        signal: opts.signal,
        windowsHide: true,
        // Comfortably above anything a shallow clone of a single branch or a
        // metadata command should ever print; caps memory if git is somehow
        // coaxed into an unexpectedly chatty failure mode.
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Trims and strips anything that looks like embedded credentials before this ever reaches a log line or a persisted error column — defense in depth, since Phase 1's validation already rejects credential-containing URLs before a repository can be connected at all. */
export function sanitizeGitError(message: string): string {
  const withoutCredentials = message.replace(/:\/\/[^/@\s]+@/g, '://');
  const collapsed = withoutCredentials.replace(/\s+/g, ' ').trim();
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}…` : collapsed;
}

export class GitCloneError extends Error {
  constructor(
    message: string,
    public readonly cause: 'branch_not_found' | 'aborted' | 'git_error' | 'auth_failed',
  ) {
    super(message);
    this.name = 'GitCloneError';
  }
}

/** A credential for one remote git operation — never persisted, never logged (see buildAuthHeaderArgs/scrubGitCredentials). Same shape pushBranch has always taken as separate arguments; introduced here as an object purely because clone/branchExistsOnRemote/getRemoteDefaultBranch are all optional (most calls are still for public repos and pass none). */
export interface GitCredentials {
  token: string;
  username?: string;
}

/**
 * Builds the same per-invocation `http.extraheader` Basic-auth args pushBranch
 * has always used — [] when no credentials are given, so every caller that
 * never had (or needed) auth keeps its exact prior argv and behavior.
 *
 * Bugfix: also disables `credential.helper` for this one invocation
 * (`-c credential.helper=`, an empty value, per-invocation only — never
 * written to `.git/config`). Without this, a system/global credential
 * helper — Git Credential Manager (`credential.helper=manager`) is the
 * Windows Git default and was in fact configured on the machine this was
 * found on — that already holds a cached credential for the same host
 * supplies its OWN Authorization header via libcurl's auth phase, on top of
 * the explicit `http.extraheader` set below. Git sends both: `http.extraheader`
 * is a cumulative multi-value config key, so the request ends up carrying
 * two literal `Authorization` headers. GitHub's HTTP layer rejects that
 * outright with `400 Duplicate header: "Authorization"` — confirmed live,
 * this is exactly the error `branchExistsOnRemote` surfaced. Clearing the
 * helper for this invocation ensures the explicit header is the only one
 * git ever sends, regardless of what credential helpers are configured on
 * the host running this.
 */
function buildAuthHeaderArgs(credentials?: GitCredentials): string[] {
  if (!credentials) return [];
  const basicAuth = Buffer.from(`${credentials.username ?? 'x-access-token'}:${credentials.token}`).toString('base64');
  return ['-c', 'credential.helper=', '-c', `http.extraheader=AUTHORIZATION: basic ${basicAuth}`];
}

/**
 * Per-invocation override — NEVER a global/persistent config write — that
 * disables Git's own CRLF<->LF conversion. Phase 14 finding:
 * repository-fix-validation.ts carefully preserves a file's real line-ending
 * bytes when applying a hunk (see applyHunkToContent), but that guarantee was
 * being silently undone one step later — `git add` applies the HOST
 * MACHINE's global `core.autocrlf` setting (commonly `true` on Windows) when
 * staging, converting a carefully-CRLF-preserved file back to LF the moment
 * it's staged, with no error or warning.
 *
 * Step 13A finding: applying this override ONLY to `add`/`commit` (its
 * original Phase 14 scope) is not enough — `cloneRepository` below had no
 * override at all, so on a host with `core.autocrlf=true` an LF-committed
 * blob gets checked out as an entirely-CRLF working tree BEFORE any hunk is
 * ever applied. `add`/`commit`'s override then faithfully preserves that
 * host-dependent, already-corrupted CRLF working tree verbatim, producing a
 * full-file rewrite in the resulting commit (every line "changed" purely by
 * line-ending encoding) instead of the one real line that was touched.
 *
 * Applying this SAME override to `clone` too closes that gap: the working
 * tree is now always byte-identical to the real Git blob, regardless of the
 * host's global `core.autocrlf`/`core.safecrlf` setting, so a file's
 * checked-out line-ending convention always matches its actual commit
 * history — LF stays LF, CRLF stays CRLF — and `add`/`commit`'s existing
 * override then correctly preserves exactly that (plus whatever
 * applyHunkToContent legitimately changed) with no host-dependent surprises.
 * Never written to `.git/config`, never affecting any other git invocation.
 */
const NO_LINE_ENDING_CONVERSION = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

/**
 * Shallow-clones exactly the requested branch — `--single-branch --depth 1`
 * means only that branch's latest commit is fetched, never the full history
 * or other branches, which keeps this fast and bounds the amount of Git
 * metadata pulled down regardless of the repository's real size. If the
 * branch doesn't exist on the remote, git itself fails the command (nothing
 * is silently cloned from a different branch).
 *
 * Uses NO_LINE_ENDING_CONVERSION so the checked-out working tree is always
 * byte-identical to the real Git blob — see that constant's doc comment
 * (Step 13A) for why this matters for the fix-application/commit pipeline.
 */
export async function cloneRepository(repoUrl: string, branch: string, targetDir: string, signal: AbortSignal, credentials?: GitCredentials): Promise<void> {
  try {
    await run(
      ['clone', ...NO_LINE_ENDING_CONVERSION, ...buildAuthHeaderArgs(credentials), '--branch', branch, '--single-branch', '--depth', '1', '--no-tags', '--quiet', '--', repoUrl, targetDir],
      { signal },
    );
    // Bugfix: unlike fetch/push/ls-remote (where `-c key=value` is purely
    // transient), `git clone -c http.extraheader=...` writes that value into
    // the NEW repository's own `.git/config` as `[http] extraheader = ...` —
    // confirmed live, with a real token sitting in it on disk afterward,
    // directly contradicting this module's "never written to .git/config"
    // intent (see buildAuthHeaderArgs's doc comment). Left in place, it also
    // breaks every later authenticated call: `http.extraheader` is a
    // cumulative multi-value config key, so branchExistsOnRemote/pushBranch's
    // own per-invocation `-c http.extraheader=...` (via buildAuthHeaderArgs)
    // stacks on top of this persisted one, and git sends BOTH — which
    // GitHub's HTTP layer now hard-rejects as `400 Duplicate header:
    // "Authorization"`. Stripping it immediately after a successful
    // authenticated clone closes both problems: no credential is left on
    // disk, and every later invocation's own explicit header is the only one
    // git ever sends.
    if (credentials) {
      await run(['-C', targetDir, 'config', '--unset-all', 'http.extraheader'], { signal }).catch(() => {});
    }
  } catch (error) {
    if (signal.aborted) {
      throw new GitCloneError('Clone aborted', 'aborted');
    }
    const rawStderr = (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error));
    const stderr = scrubGitCredentials(sanitizeGitError(rawStderr), credentials ? [credentials.token] : []);
    if (/remote branch .* not found|couldn't find remote ref|not found in upstream/i.test(stderr)) {
      throw new GitCloneError(`Branch '${branch}' does not exist on this repository.`, 'branch_not_found');
    }
    if (credentials && /authentication failed|401|403|could not read username/i.test(stderr)) {
      throw new GitCloneError(`Git clone authentication failed: ${stderr}`, 'auth_failed');
    }
    throw new GitCloneError(`Git clone failed: ${stderr}`, 'git_error');
  }
}

/** Reads the checked-out commit SHA directly from the clone — never trusts a caller-supplied value. */
export async function getCommitSha(repoDir: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await run(['-C', repoDir, 'rev-parse', 'HEAD'], { signal });
  return stdout.trim();
}

export interface WorkingTreeDiffFile {
  filePath: string;
  additions: number;
  deletions: number;
}

/**
 * Real, unstaged `git diff` of a working tree against its own HEAD — used by
 * Phase 11's fix-application pipeline to report exactly what changed in an
 * isolated workspace. Never fabricated from oldText/newText, and never
 * stages/commits/pushes anything — read-only `git diff`/`git diff --numstat`
 * only, through the same argv-array execFile as every other call in this
 * module.
 */
export async function getWorkingTreeDiff(repoDir: string, signal?: AbortSignal): Promise<{ diff: string; files: WorkingTreeDiffFile[] }> {
  const [diffResult, numstatResult] = await Promise.all([
    run(['-C', repoDir, 'diff', '--no-color', '--'], { signal }),
    run(['-C', repoDir, 'diff', '--numstat', '--'], { signal }),
  ]);

  const files: WorkingTreeDiffFile[] = numstatResult.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [additions, deletions, filePath] = line.split('\t');
      return { filePath, additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
    });

  return { diff: diffResult.stdout, files };
}

/**
 * Strips anything that could plausibly be a leaked credential — an
 * `http.extraheader`/`Authorization` value, a bare `Basic`/`Bearer` token,
 * or (if the caller knows the exact secret, e.g. pushBranch below) the
 * literal secret string itself — before an error message from this module
 * is ever logged or returned to an HTTP caller. Applied IN ADDITION TO
 * sanitizeGitError's URL-credential stripping, not instead of it.
 */
export function scrubGitCredentials(message: string, knownSecrets: string[] = []): string {
  let scrubbed = message
    .replace(/AUTHORIZATION:.*/gi, 'AUTHORIZATION: ***')
    .replace(/\b(Basic|Bearer)\s+\S+/gi, '$1 ***')
    .replace(/http\.extraheader=.*/gi, 'http.extraheader=***');
  for (const secret of knownSecrets) {
    if (secret) scrubbed = scrubbed.split(secret).join('***');
  }
  return scrubbed;
}

export class GitWorkflowError extends Error {
  constructor(
    message: string,
    public readonly cause: 'branch_exists' | 'branch_invalid' | 'dirty_worktree' | 'commit_failed' | 'push_failed' | 'auth_failed' | 'remote_unavailable' | 'git_error',
  ) {
    super(message);
    this.name = 'GitWorkflowError';
  }
}

/** Porcelain `git status --short` — used by the fix-workflow service to verify the working tree contains ONLY the expected changed files before ever staging/committing anything. */
export async function getStatusShort(repoDir: string, signal?: AbortSignal): Promise<Array<{ statusCode: string; filePath: string }>> {
  const { stdout } = await run(['-C', repoDir, 'status', '--short', '--untracked-files=all'], { signal });
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ statusCode: line.slice(0, 2).trim(), filePath: line.slice(3).trim() }));
}

/**
 * Creates and checks out a new branch from the current HEAD. Rejects (as
 * GitWorkflowError with cause 'branch_exists') if the branch already exists
 * LOCALLY in this workspace — the caller is responsible for checking remote
 * existence separately (branchExistsOnRemote) and choosing a non-colliding
 * name before ever calling this, since a local isolated workspace's freshly
 * created branch never pre-exists there in practice.
 */
export async function createBranch(repoDir: string, branchName: string, signal?: AbortSignal): Promise<void> {
  try {
    await run(['-C', repoDir, 'checkout', '-b', branchName], { signal });
  } catch (error) {
    const stderr = sanitizeGitError((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error)));
    if (/already exists/i.test(stderr)) throw new GitWorkflowError(`Branch '${branchName}' already exists.`, 'branch_exists');
    throw new GitWorkflowError(`Failed to create branch: ${stderr}`, 'git_error');
  }
}

/** `git ls-remote --exit-code --heads origin <branch>` — exit code 2 means "no such ref", which execFile reports as a non-zero-exit error; that specific case is treated as "does not exist" rather than an error. Any OTHER failure (auth, network) is surfaced as remote_unavailable. */
export async function branchExistsOnRemote(repoDir: string, branchName: string, signal?: AbortSignal, credentials?: GitCredentials): Promise<boolean> {
  try {
    const { stdout } = await run(['-C', repoDir, ...buildAuthHeaderArgs(credentials), 'ls-remote', '--exit-code', '--heads', 'origin', branchName], { signal });
    return stdout.trim().length > 0;
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 2) return false;
    const rawStderr = (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error));
    const stderr = scrubGitCredentials(sanitizeGitError(rawStderr), credentials ? [credentials.token] : []);
    throw new GitWorkflowError(`Failed to check the remote for an existing branch: ${stderr}`, 'remote_unavailable');
  }
}

/** `git ls-remote --symref origin HEAD` — resolves the remote's actual default branch without a full clone/fetch. Returns undefined if the remote's default branch cannot be determined (caller falls back to a configured/heuristic default). */
export async function getRemoteDefaultBranch(repoDir: string, signal?: AbortSignal, credentials?: GitCredentials): Promise<string | undefined> {
  try {
    const { stdout } = await run(['-C', repoDir, ...buildAuthHeaderArgs(credentials), 'ls-remote', '--symref', 'origin', 'HEAD'], { signal });
    const match = stdout.match(/ref:\s*refs\/heads\/(\S+)\s+HEAD/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Stages ONLY the given file paths — never `git add .` / `git add -A`. Every
 * path is passed as a discrete argv element after `--`, so a path
 * containing shell metacharacters is inert (same discipline as cloneRepository).
 */
export async function stageFiles(repoDir: string, filePaths: string[], signal?: AbortSignal): Promise<void> {
  if (filePaths.length === 0) return;
  await run(['-C', repoDir, ...NO_LINE_ENDING_CONVERSION, 'add', '--', ...filePaths], { signal });
}

/**
 * Commits whatever is currently staged, using a per-invocation `-c
 * user.name=/-c user.email=` identity — NEVER a global `git config` write,
 * so this workspace's commit identity can never leak into or persist
 * outside this one command. The commit message is passed as a single argv
 * element (never shell-interpolated), so AI-influenced text in it can never
 * be interpreted as a shell command.
 */
export async function commitStaged(repoDir: string, message: string, authorName: string, authorEmail: string, signal?: AbortSignal): Promise<void> {
  try {
    await run(
      ['-C', repoDir, ...NO_LINE_ENDING_CONVERSION, '-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '--no-verify', '-m', message],
      { signal },
    );
  } catch (error) {
    const stderr = sanitizeGitError((error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error)));
    throw new GitWorkflowError(`Failed to create commit: ${stderr}`, 'commit_failed');
  }
}

/**
 * Pushes `branchName` to `origin` using a per-invocation `http.extraheader`
 * (an HTTP Basic header built from `username`/`token`) — never written into
 * `.git/config`, never placed in the remote URL, and never logged: any
 * error is sanitized via scrubGitCredentials (with the literal token as a
 * known secret) before it ever leaves this function.
 *
 * `username` defaults to `x-access-token` (GitHub's own convention) so
 * every pre-Phase-13 call site — which only ever pushed to GitHub and never
 * passed a 5th argument — keeps its exact original behavior unchanged.
 * Phase 13's other providers pass their own convention explicitly (see
 * RepositoryProviderClient.getPushCredentials): GitLab uses `oauth2`;
 * Bitbucket uses `x-token-auth` for its production OAuth path, or the real
 * account username only for the legacy App Password fallback. This function
 * itself has no provider-specific knowledge — it only ever builds a
 * Basic-auth header from whatever it's given.
 */
export async function pushBranch(repoDir: string, branchName: string, token: string, signal?: AbortSignal, username = 'x-access-token'): Promise<void> {
  const basicAuth = Buffer.from(`${username}:${token}`).toString('base64');
  try {
    await run(
      ['-C', repoDir, ...buildAuthHeaderArgs({ token, username }), 'push', '--set-upstream', 'origin', '--', branchName],
      { signal },
    );
  } catch (error) {
    const rawStderr = (error as { stderr?: string }).stderr ?? (error instanceof Error ? error.message : String(error));
    const stderr = scrubGitCredentials(sanitizeGitError(rawStderr), [token, basicAuth]);
    if (/authentication failed|401|403|could not read username/i.test(stderr)) {
      throw new GitWorkflowError(`Push authentication failed: ${stderr}`, 'auth_failed');
    }
    throw new GitWorkflowError(`Failed to push branch: ${stderr}`, 'push_failed');
  }
}

/** `git rev-parse HEAD` after a commit — same primitive as getCommitSha, re-exported under a workflow-specific name for call-site clarity in repository-fix-workflow-service.ts. */
export const getHeadCommitSha = getCommitSha;
