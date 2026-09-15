import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRepositoryPathSafe, normalizeRepositoryPath } from './repository-path-safety.js';

describe('isRepositoryPathSafe', () => {
  it('accepts an ordinary relative path', () => {
    assert.equal(isRepositoryPathSafe('src/components/HealthBanner.tsx'), true);
  });

  it('rejects an empty path', () => {
    assert.equal(isRepositoryPathSafe(''), false);
  });

  it('rejects an absolute POSIX path', () => {
    assert.equal(isRepositoryPathSafe('/etc/passwd'), false);
  });

  it('rejects a Windows drive-letter absolute path', () => {
    assert.equal(isRepositoryPathSafe('C:\\Windows\\System32\\config'), false);
  });

  it('rejects a home-relative path', () => {
    assert.equal(isRepositoryPathSafe('~/secrets.txt'), false);
  });

  it('rejects ../ traversal', () => {
    assert.equal(isRepositoryPathSafe('../../etc/passwd'), false);
  });

  it('rejects a bare "." segment', () => {
    assert.equal(isRepositoryPathSafe('src/./index.ts'), false);
  });

  it('rejects a path containing a null byte', () => {
    assert.equal(isRepositoryPathSafe('src/index.ts\0.png'), false);
  });
});

describe('normalizeRepositoryPath', () => {
  it('trims whitespace', () => {
    assert.equal(normalizeRepositoryPath('  src/index.ts  '), 'src/index.ts');
  });

  it('strips a leading ./', () => {
    assert.equal(normalizeRepositoryPath('./src/index.ts'), 'src/index.ts');
  });

  it('normalizes backslashes to forward slashes', () => {
    assert.equal(normalizeRepositoryPath('src\\index.ts'), 'src/index.ts');
  });
});
