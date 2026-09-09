import { loadEnv, repoRoot } from './load-env.mjs';

loadEnv();

import { spawn } from 'node:child_process';

const root = repoRoot;
const withTestSite = process.argv.includes('--with-test-site');
const withInfra = process.env.SKIP_INFRA !== '1';

async function ensureInfra() {
  if (!withInfra) return;
  try {
    await fetch('http://localhost:5433', { signal: AbortSignal.timeout(500) });
  } catch {
    console.log('[dev] Tip: run `docker compose up -d` for PostgreSQL + Redis (website scans)');
  }
}

const services = [
  { name: 'browser-worker', script: 'dev:browser-worker', port: 3101, path: '/health' },
  { name: 'ai-router', script: 'dev:ai-router', port: 3102, path: '/health' },
  { name: 'api', script: 'dev:api', port: 3100, path: '/health' },
  { name: 'web', script: 'dev:web', port: 5173, path: '/' },
];

if (withTestSite) {
  services.push({ name: 'test-website', script: 'test:website', port: 8080, path: '/' });
}

const children = [];

function runPnpm(script) {
  const child = spawn('pnpm', [script], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${script} exited with code ${code}`);
    }
  });
  return child;
}

async function waitFor(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function printChecklist() {
  const checks = await Promise.all(
    services.map(async (s) => {
      const ok = await waitFor(`http://localhost:${s.port}${s.path}`, 60000);
      return { ...s, ok };
    }),
  );

  console.log('\n--- Origami Lens dev services ---');
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}  http://localhost:${c.port}`);
  }
  console.log('  Dashboard: http://localhost:5173');
  console.log('  API health: http://localhost:3100/health/dependencies');
  console.log('  Website scans: docker compose up -d && pnpm db:migrate');
  if (process.env.DATABASE_URL) {
    console.log('  DATABASE_URL: configured');
  } else {
    console.log('  DATABASE_URL: not set (website scans disabled)');
  }
  console.log('---------------------------------\n');

  if (!checks.every((c) => c.ok)) {
    console.warn('[dev] Some services did not respond in time. Check port conflicts.');
  }
}

console.log('[dev] Starting Origami Lens services...');
ensureInfra().catch(() => {});
for (const s of services) {
  runPnpm(s.script);
}

setTimeout(() => {
  printChecklist().catch(console.error);
}, 5000);

function shutdown() {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
