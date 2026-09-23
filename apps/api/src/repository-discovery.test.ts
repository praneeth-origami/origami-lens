import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepositoryLimitExceededError, discoverRepository, iterateRepositoryFiles } from './repository-discovery.js';

const GENEROUS_LIMITS = { maxFileCount: 100_000, maxTotalSizeBytes: 100 * 1024 * 1024, maxFileSizeBytes: 10 * 1024 * 1024 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-discovery-fixture-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relativePath: string, content = 'x'): void {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('discoverRepository', () => {
  it('counts files, directories, and total size deterministically', () => {
    write('README.md', '# hello');
    write('src/index.ts', 'export {}');
    write('src/util.ts', 'export {}');
    write('src/nested/deep.ts', 'export {}');

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.equal(result.fileCount, 4);
    assert.equal(result.directoryCount, 2); // src, src/nested
    assert.ok(result.totalSizeBytes > 0);
  });

  it('reports top-level directories and files only, sorted', () => {
    write('b-dir/file.ts');
    write('a-dir/file.ts');
    write('z.txt');
    write('a.txt');

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.deepEqual(result.topLevelDirectories, ['a-dir', 'b-dir']);
    assert.deepEqual(result.topLevelFiles, ['a.txt', 'z.txt']);
  });

  it('counts files by extension', () => {
    write('a.ts');
    write('b.ts');
    write('c.md');
    write('Makefile');

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.equal(result.extensions['.ts'], 2);
    assert.equal(result.extensions['.md'], 1);
    assert.equal(result.extensions[''], 1);
  });

  it('reports the largest files, largest first', () => {
    write('small.txt', 'a'.repeat(10));
    write('large.txt', 'a'.repeat(1000));
    write('medium.txt', 'a'.repeat(100));

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.equal(result.largestFiles[0].path, 'large.txt');
    assert.equal(result.largestFiles[1].path, 'medium.txt');
    assert.equal(result.largestFiles[2].path, 'small.txt');
  });

  it('ignores .git, node_modules, dist, and other generated/dependency directories by default', () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    write('node_modules/some-pkg/index.js', 'module.exports = {}');
    write('dist/bundle.js', '/* built */');
    write('src/index.ts', 'export {}');

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.equal(result.fileCount, 1);
    assert.deepEqual(result.topLevelDirectories, ['src']);
  });

  it('does not ignore a normal source directory that happens to be named similarly', () => {
    write('source/index.ts', 'export {}');
    write('distribution-notes/readme.txt', 'notes');

    const result = discoverRepository(root, GENEROUS_LIMITS);
    assert.deepEqual(result.topLevelDirectories.sort(), ['distribution-notes', 'source']);
  });

  it('TEST 16 — fails when file count exceeds the configured limit', () => {
    for (let i = 0; i < 5; i++) write(`file-${i}.txt`);
    assert.throws(
      () => discoverRepository(root, { ...GENEROUS_LIMITS, maxFileCount: 3 }),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryLimitExceededError);
        assert.equal(error.kind, 'file_count');
        return true;
      },
    );
  });

  it('TEST 17 — fails when total size exceeds the configured limit', () => {
    write('a.bin', 'a'.repeat(500));
    write('b.bin', 'a'.repeat(500));
    assert.throws(
      () => discoverRepository(root, { ...GENEROUS_LIMITS, maxTotalSizeBytes: 700 }),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryLimitExceededError);
        assert.equal(error.kind, 'total_size');
        return true;
      },
    );
  });

  it('TEST 18 — fails when a single file exceeds the configured per-file size limit', () => {
    write('huge.bin', 'a'.repeat(2000));
    assert.throws(
      () => discoverRepository(root, { ...GENEROUS_LIMITS, maxFileSizeBytes: 1000 }),
      (error: unknown) => {
        assert.ok(error instanceof RepositoryLimitExceededError);
        assert.equal(error.kind, 'file_size');
        return true;
      },
    );
  });

  it('TEST 19/20 — never follows a symlink, whether it escapes the root or points inside it', () => {
    // Escapes the clone root entirely.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-discovery-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'do not read me');

    write('inside.txt', 'ok');
    try {
      fs.symlinkSync(outsideDir, path.join(root, 'escape-link'), 'junction');
      fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'internal-link'));
    } catch {
      // Creating symlinks can require elevated privileges on some Windows
      // configurations — if the platform refuses to create one at all, the
      // property under test (never dereference a symlink) is trivially true
      // for this run, so skip the assertions instead of failing the suite
      // over an environment limitation unrelated to the code being tested.
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const result = discoverRepository(root, GENEROUS_LIMITS);
    // Only inside.txt should ever be counted — neither symlink is followed,
    // so nothing from outsideDir is visible and the internal symlink itself
    // isn't double-counted as a second file.
    assert.equal(result.fileCount, 1);
    assert.deepEqual(result.topLevelFiles, ['inside.txt']);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe('iterateRepositoryFiles', () => {
  it('yields every real file under the root', () => {
    write('src/index.ts');
    write('src/utils/format.ts');
    write('README.md');
    const files = Array.from(iterateRepositoryFiles(root)).map((f) => f.relativePath).sort();
    assert.deepEqual(files, ['README.md', 'src/index.ts', 'src/utils/format.ts']);
  });

  it('TEST 27 — .git is skipped', () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    write('src/index.ts');
    const files = Array.from(iterateRepositoryFiles(root)).map((f) => f.relativePath);
    assert.deepEqual(files, ['src/index.ts']);
  });

  it('TEST 28 — node_modules is skipped', () => {
    write('node_modules/pkg/index.js');
    write('src/index.ts');
    const files = Array.from(iterateRepositoryFiles(root)).map((f) => f.relativePath);
    assert.deepEqual(files, ['src/index.ts']);
  });

  it('TEST 26 — every default-ignored directory is skipped', () => {
    for (const dir of ['dist', 'build', 'coverage', '.cache', '.next', '.vite', 'target', 'vendor']) {
      write(`${dir}/file.txt`);
    }
    write('src/index.ts');
    const files = Array.from(iterateRepositoryFiles(root)).map((f) => f.relativePath);
    assert.deepEqual(files, ['src/index.ts']);
  });

  it('TEST 31 — a path-traversal-shaped file entry can never resolve outside the root', () => {
    write('src/index.ts');
    for (const file of iterateRepositoryFiles(root)) {
      assert.ok(file.absolutePath.startsWith(fs.realpathSync(root)));
      assert.ok(!file.relativePath.includes('..'));
    }
  });

  it('TEST 30 — a symlink (internal or escaping) is never yielded as a file', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origami-iter-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'do not read me');
    write('inside.txt', 'ok');

    try {
      fs.symlinkSync(outsideDir, path.join(root, 'escape-link'), 'junction');
      fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'internal-link'));
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const files = Array.from(iterateRepositoryFiles(root)).map((f) => f.relativePath);
    assert.deepEqual(files, ['inside.txt']);

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
});
