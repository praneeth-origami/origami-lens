import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { processRepositoryFile, isIgnoredFile } from './repository-index-service.js';
import { iterateRepositoryFiles } from './repository-discovery.js';

const CONTEXT = { repositoryId: 'repo-1', commitSha: 'abc123' };
const LIMITS = { maxFileSizeBytes: 1024 * 1024 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-index-service-fixture-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content: string | Buffer): string {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function entryFor(relativePath: string) {
  return { absolutePath: path.join(root, relativePath), relativePath };
}

describe('processRepositoryFile', () => {
  it('indexes a real TypeScript file end to end, producing real chunks', async () => {
    write('src/math.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const result = await processRepositoryFile(entryFor('src/math.ts'), CONTEXT, LIMITS);
    assert.equal(result.status, 'INDEXED');
    assert.equal(result.language, 'typescript');
    assert.ok(result.contentHash);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].symbol, 'add');
  });

  it('TEST 29 — a sensitive file is skipped and its content is never read into the result', async () => {
    write('.env', 'SECRET_KEY=super-secret-value\n');
    const result = await processRepositoryFile(entryFor('.env'), CONTEXT, LIMITS);
    assert.equal(result.status, 'SKIPPED_SENSITIVE');
    assert.equal(result.chunks.length, 0);
    assert.equal(result.contentHash, undefined);
  });

  it('a binary file is skipped without being parsed', async () => {
    write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    const result = await processRepositoryFile(entryFor('assets/logo.png'), CONTEXT, LIMITS);
    assert.equal(result.status, 'SKIPPED_BINARY');
    assert.equal(result.chunks.length, 0);
  });

  it('an oversized file is skipped without further processing', async () => {
    write('huge.ts', 'export const x = 1;\n');
    const result = await processRepositoryFile(entryFor('huge.ts'), CONTEXT, { maxFileSizeBytes: 1 });
    assert.equal(result.status, 'SKIPPED_TOO_LARGE');
    assert.equal(result.chunks.length, 0);
  });

  it('an unsupported language (html) is skipped without chunking', async () => {
    write('index.html', '<html><body>hi</body></html>');
    const result = await processRepositoryFile(entryFor('index.html'), CONTEXT, LIMITS);
    assert.equal(result.status, 'SKIPPED_UNSUPPORTED_LANGUAGE');
    assert.equal(result.chunks.length, 0);
  });

  it('an unknown extension is skipped as unsupported', async () => {
    write('data.xyz', 'whatever content');
    const result = await processRepositoryFile(entryFor('data.xyz'), CONTEXT, LIMITS);
    assert.equal(result.status, 'SKIPPED_UNSUPPORTED_LANGUAGE');
  });

  it('a lockfile is skipped as ignored, matching isIgnoredFile', async () => {
    write('package-lock.json', '{}');
    assert.equal(isIgnoredFile('package-lock.json'), true);
    const result = await processRepositoryFile(entryFor('package-lock.json'), CONTEXT, LIMITS);
    assert.equal(result.status, 'SKIPPED_IGNORED');
  });

  it('a file with genuinely malformed source still indexes whatever real symbols it can find', async () => {
    write('broken.ts', 'export function broken( {\n\nexport function ok() { return 1; }\n');
    const result = await processRepositoryFile(entryFor('broken.ts'), CONTEXT, LIMITS);
    assert.equal(result.status, 'INDEXED');
    assert.ok(result.chunks.some((c) => c.symbol === 'ok'));
  });

  it('content hash is deterministic across repeated processing of the same file', async () => {
    write('src/a.ts', 'export const a = 1;\n');
    const first = await processRepositoryFile(entryFor('src/a.ts'), CONTEXT, LIMITS);
    const second = await processRepositoryFile(entryFor('src/a.ts'), CONTEXT, LIMITS);
    assert.equal(first.contentHash, second.contentHash);
    assert.deepEqual(first.chunks, second.chunks);
  });
});

describe('integration — a small realistic repository fixture', () => {
  it('demonstrates ignored directories, a sensitive file, TSX/TS, multiple symbols, imports, and exports all together', async () => {
    write('src/components/Header.tsx', "import React from 'react';\n\nexport function Header(props: { title: string }) {\n  return <h1>{props.title}</h1>;\n}\n");
    write('src/components/Button.tsx', "export const Button = () => <button>Click</button>;\n");
    write('src/services/auth.ts', "export class AuthService {\n  login(user: string) {\n    return user;\n  }\n}\n");
    write('src/utils/format.ts', "export function formatDate(d: Date) {\n  return d.toISOString();\n}\n");
    write('package.json', '{"name": "fixture"}');
    write('README.md', '# Fixture repo');
    write('.env', 'SECRET=1');
    write('node_modules/some-dep/index.js', 'module.exports = {};');

    const results = [];
    for (const entry of iterateRepositoryFiles(root)) {
      results.push(await processRepositoryFile(entry, CONTEXT, LIMITS));
    }

    const byPath = Object.fromEntries(results.map((r) => [r.relativePath, r]));

    // node_modules never even reaches processRepositoryFile — iterateRepositoryFiles excludes it entirely.
    assert.ok(!('node_modules/some-dep/index.js' in byPath));

    assert.equal(byPath['.env'].status, 'SKIPPED_SENSITIVE');
    assert.equal(byPath['package.json'].status, 'INDEXED'); // JSON is parseable
    assert.equal(byPath['README.md'].status, 'SKIPPED_UNSUPPORTED_LANGUAGE');
    assert.equal(byPath['src/components/Header.tsx'].status, 'INDEXED');
    assert.equal(byPath['src/services/auth.ts'].status, 'INDEXED');

    const filesIndexed = results.filter((r) => r.status === 'INDEXED').length;
    const filesSkipped = results.filter((r) => r.status !== 'INDEXED').length;
    const chunksCreated = results.reduce((sum, r) => sum + r.chunks.length, 0);

    assert.ok(filesIndexed > 0);
    assert.ok(filesSkipped > 0);
    assert.ok(chunksCreated > 0);

    const headerChunk = byPath['src/components/Header.tsx'].chunks.find((c) => c.symbol === 'Header');
    assert.equal(headerChunk?.symbolType, 'component');
    assert.equal(headerChunk?.isExported, true);

    const buttonChunk = byPath['src/components/Button.tsx'].chunks.find((c) => c.symbol === 'Button');
    assert.equal(buttonChunk?.symbolType, 'component');

    const authChunk = byPath['src/services/auth.ts'].chunks.find((c) => c.symbol === 'AuthService');
    assert.equal(authChunk?.symbolType, 'class');
    const loginChunk = byPath['src/services/auth.ts'].chunks.find((c) => c.symbol === 'login');
    assert.equal(loginChunk?.parentSymbol, 'AuthService');
  });
});
