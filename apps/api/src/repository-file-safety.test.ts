import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasKnownBinaryExtension, isLikelyBinaryFile, isSensitiveFile, looksBinaryFromContent } from './repository-file-safety.js';

describe('binary detection', () => {
  it('TEST 7 — a known binary extension is flagged without inspecting content', () => {
    assert.equal(hasKnownBinaryExtension('assets/logo.png'), true);
    assert.equal(isLikelyBinaryFile('assets/logo.png', Buffer.from('not actually binary but extension says so')), true);
  });

  it('TEST 8 — a normal text file is accepted', () => {
    const buffer = Buffer.from('export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
    assert.equal(isLikelyBinaryFile('src/math.ts', buffer), false);
  });

  it('content sniffing catches a binary file with an unfamiliar/mislabeled extension (does not rely only on extension)', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]); // PNG-like bytes with a NUL
    assert.equal(hasKnownBinaryExtension('mystery.dat'), false);
    assert.equal(looksBinaryFromContent(buffer), true);
    assert.equal(isLikelyBinaryFile('mystery.dat', buffer), true);
  });

  it('a text file with no NUL bytes and an unfamiliar extension is not flagged as binary', () => {
    const buffer = Buffer.from('just some plain text content', 'utf8');
    assert.equal(isLikelyBinaryFile('notes.customext', buffer), false);
  });
});

describe('sensitive file detection', () => {
  it('TEST 29 — .env and its variants are flagged', () => {
    assert.equal(isSensitiveFile('.env'), true);
    assert.equal(isSensitiveFile('.env.local'), true);
    assert.equal(isSensitiveFile('.env.production'), true);
  });

  it('private key files are flagged', () => {
    assert.equal(isSensitiveFile('server.pem'), true);
    assert.equal(isSensitiveFile('private.key'), true);
    assert.equal(isSensitiveFile('id_rsa'), true);
    assert.equal(isSensitiveFile('id_ed25519'), true);
  });

  it('a normal source file is not flagged as sensitive', () => {
    assert.equal(isSensitiveFile('src/index.ts'), false);
    assert.equal(isSensitiveFile('README.md'), false);
    assert.equal(isSensitiveFile('package.json'), false);
  });

  it('sensitive detection matches only the filename, not the full path (defense in depth, not path-dependent)', () => {
    assert.equal(isSensitiveFile('config/nested/deep/.env'), true);
  });
});
