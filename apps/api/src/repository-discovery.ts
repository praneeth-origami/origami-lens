import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepositoryDiscoveryMetadata } from '@origami/contracts';
import { isPathInside } from './repository-clone-service.js';

/** Generated/dependency/build directories that would otherwise dominate the discovery result without being source content. Extensible — callers may pass their own set. */
export const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '.vite',
  'target',
  'vendor',
]);

export type RepositoryLimitKind = 'file_count' | 'total_size' | 'file_size';

export class RepositoryLimitExceededError extends Error {
  constructor(
    message: string,
    public readonly kind: RepositoryLimitKind,
  ) {
    super(message);
    this.name = 'RepositoryLimitExceededError';
  }
}

export interface DiscoveryLimits {
  maxFileCount: number;
  maxTotalSizeBytes: number;
  maxFileSizeBytes: number;
}

const LARGEST_FILES_TRACKED = 10;

/**
 * Deterministically walks a cloned repository and reports its structure —
 * no file contents are ever read, only names and sizes via `lstat`/`stat`.
 * Symlinks are never followed (traversed into or size-counted), whether they
 * point inside or outside the clone root: a malicious repository can plant a
 * symlink pointing anywhere on the host filesystem, and the only fully safe
 * handling is to never dereference it during untrusted discovery. This is
 * deliberately stricter than "reject only escaping symlinks" — it removes
 * the class of bug entirely (including symlink cycles) rather than trying to
 * enumerate every unsafe case.
 */
export function discoverRepository(
  rootDir: string,
  limits: DiscoveryLimits,
  ignoredDirectoryNames: Set<string> = DEFAULT_IGNORED_DIRECTORY_NAMES,
): RepositoryDiscoveryMetadata {
  const resolvedRoot = fs.realpathSync(rootDir);

  let fileCount = 0;
  let directoryCount = 0;
  let totalSizeBytes = 0;
  const extensions: Record<string, number> = {};
  const largestFiles: Array<{ path: string; sizeBytes: number }> = [];
  const topLevelDirectories: string[] = [];
  const topLevelFiles: string[] = [];

  const recordLargestFile = (relativePath: string, sizeBytes: number) => {
    largestFiles.push({ path: relativePath, sizeBytes });
    largestFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
    if (largestFiles.length > LARGEST_FILES_TRACKED) largestFiles.length = LARGEST_FILES_TRACKED;
  };

  const stack: string[] = [resolvedRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const isRoot = dir === resolvedRoot;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, or removed mid-walk) — skip it
      // rather than failing the whole discovery over one entry.
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Defense in depth beyond the symlink check below: every path we
      // touch must stay inside the clone root no matter how it was reached.
      if (!isPathInside(resolvedRoot, fullPath)) continue;

      if (entry.isSymbolicLink()) {
        // Never dereferenced — see the function-level comment.
        continue;
      }

      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name)) continue;
        directoryCount += 1;
        if (isRoot) topLevelDirectories.push(entry.name);
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(fullPath).size;
      } catch {
        continue;
      }

      if (sizeBytes > limits.maxFileSizeBytes) {
        throw new RepositoryLimitExceededError(
          `File "${path.relative(resolvedRoot, fullPath)}" (${sizeBytes} bytes) exceeds the configured per-file limit of ${limits.maxFileSizeBytes} bytes.`,
          'file_size',
        );
      }

      fileCount += 1;
      if (fileCount > limits.maxFileCount) {
        throw new RepositoryLimitExceededError(
          `Repository contains more than the configured limit of ${limits.maxFileCount} files.`,
          'file_count',
        );
      }

      totalSizeBytes += sizeBytes;
      if (totalSizeBytes > limits.maxTotalSizeBytes) {
        throw new RepositoryLimitExceededError(
          `Repository total size exceeds the configured limit of ${limits.maxTotalSizeBytes} bytes.`,
          'total_size',
        );
      }

      if (isRoot) topLevelFiles.push(entry.name);

      const ext = path.extname(entry.name);
      extensions[ext] = (extensions[ext] ?? 0) + 1;
      recordLargestFile(path.relative(resolvedRoot, fullPath), sizeBytes);
    }
  }

  return {
    fileCount,
    directoryCount,
    totalSizeBytes,
    topLevelDirectories: topLevelDirectories.sort(),
    topLevelFiles: topLevelFiles.sort(),
    extensions,
    largestFiles,
  };
}

export interface DiscoveredFileEntry {
  absolutePath: string;
  /** Relative to the clone root, using forward slashes regardless of OS — the same convention repository_index_files.file_path persists. */
  relativePath: string;
}

/**
 * Streams one real (non-symlink, non-ignored, within-root) file at a time
 * instead of building an in-memory list — used by the Phase 3 index worker
 * so a large repository is processed incrementally rather than loaded into
 * memory all at once. Applies the exact same ignore-directory and
 * never-follow-symlinks rules as discoverRepository above (kept as a
 * deliberately separate, independently-tested implementation rather than a
 * shared refactor, so this streaming addition carries no risk of changing
 * discoverRepository's already-shipped, already-tested Phase 2 behavior).
 * Unlike discoverRepository, this never throws on a resource limit — the
 * caller decides per-file what to do with an oversized file (skip it and
 * keep going), which is what Phase 3's partial-failure model requires.
 */
export function* iterateRepositoryFiles(
  rootDir: string,
  ignoredDirectoryNames: Set<string> = DEFAULT_IGNORED_DIRECTORY_NAMES,
): Generator<DiscoveredFileEntry> {
  const resolvedRoot = fs.realpathSync(rootDir);
  const stack: string[] = [resolvedRoot];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (!isPathInside(resolvedRoot, fullPath)) continue;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (ignoredDirectoryNames.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      yield { absolutePath: fullPath, relativePath: path.relative(resolvedRoot, fullPath).split(path.sep).join('/') };
    }
  }
}
