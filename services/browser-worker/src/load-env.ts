import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return startDir;
}

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function loadEnv(options: { silent?: boolean } = {}): void {
  const { silent = false } = options;
  const envPath = path.join(repoRoot, '.env');
  const examplePath = path.join(repoRoot, '.env.example');

  if (!existsSync(envPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    if (!silent) {
      console.log('[env] Created .env from .env.example');
    }
  }

  if (!existsSync(envPath)) {
    return;
  }

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
    if (!silent) {
      console.log('[env] Loaded', envPath);
    }
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  if (!silent) {
    console.log('[env] Loaded', envPath);
  }
}

loadEnv();

export { loadEnv, repoRoot };
