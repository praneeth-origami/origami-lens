import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, isParseableLanguage } from './repository-language.js';

describe('detectLanguage', () => {
  it('TEST 1 — .ts is detected as typescript', () => {
    assert.equal(detectLanguage('src/index.ts'), 'typescript');
  });

  it('TEST 2 — .tsx is detected as tsx', () => {
    assert.equal(detectLanguage('src/components/Header.tsx'), 'tsx');
  });

  it('TEST 3 — .js is detected as javascript', () => {
    assert.equal(detectLanguage('src/index.js'), 'javascript');
  });

  it('TEST 4 — .jsx is detected as jsx', () => {
    assert.equal(detectLanguage('src/Card.jsx'), 'jsx');
  });

  it('TEST 5 — .py is detected as python', () => {
    assert.equal(detectLanguage('services/auth.py'), 'python');
  });

  it('TEST 6 — an unknown extension is detected as unknown', () => {
    assert.equal(detectLanguage('data.xyz123'), 'unknown');
  });

  it('a file with no extension is detected as unknown', () => {
    assert.equal(detectLanguage('Makefile'), 'unknown');
  });

  it('detects the remaining supported languages by extension', () => {
    assert.equal(detectLanguage('Main.java'), 'java');
    assert.equal(detectLanguage('main.go'), 'go');
    assert.equal(detectLanguage('lib.rs'), 'rust');
    assert.equal(detectLanguage('util.c'), 'c');
    assert.equal(detectLanguage('util.cpp'), 'cpp');
    assert.equal(detectLanguage('styles.css'), 'css');
    assert.equal(detectLanguage('package.json'), 'json');
    assert.equal(detectLanguage('index.html'), 'html');
  });

  it('normalizes extension case consistently', () => {
    assert.equal(detectLanguage('SRC/INDEX.TS'), 'typescript');
  });
});

describe('isParseableLanguage', () => {
  it('every language with a wired Tree-sitter grammar is parseable', () => {
    for (const lang of ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'css', 'json'] as const) {
      assert.equal(isParseableLanguage(lang), true, `${lang} should be parseable`);
    }
  });

  it('html is detected but not parseable (no wired grammar)', () => {
    assert.equal(isParseableLanguage('html'), false);
  });

  it('unknown is never parseable', () => {
    assert.equal(isParseableLanguage('unknown'), false);
  });
});
