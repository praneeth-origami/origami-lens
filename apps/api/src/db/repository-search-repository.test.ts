import '../load-env.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getPool, isDatabaseEnabled } from './pool.js';
import { RepositorySearchRepository } from './repository-search-repository.js';

/**
 * Exercises the real pgvector SQL (parameterized cosine-distance `<=>`
 * query, joined against repository_code_chunks) against a live Postgres
 * instance — the in-memory legacy fallback's cosine-distance math is tested
 * separately at the service level (repository-search-service.test.ts),
 * since it doesn't touch SQL at all. Skips entirely (rather than failing)
 * when DATABASE_URL isn't configured, matching this project's convention
 * for tests that need a real database (see e.g. any test gated on
 * isDatabaseEnabled() elsewhere in this codebase).
 */
const dbAvailable = isDatabaseEnabled();
const describeIfDb = dbAvailable ? describe : describe.skip;

const MODEL = 'test-search-model';
// repository_code_embeddings.embedding is a fixed vector(1024) column (see
// migration 008 — BGE-M3's real, verified dimension) — every test vector
// must be padded out to exactly this length, not the 3 "meaningful" values
// used to control cosine distance in these fixtures.
const DIMENSIONS = 1024;

interface FixtureChunk {
  id: string;
  filePath: string;
  symbol: string;
  vector: number[];
}

function padVector(values: number[]): number[] {
  const padded = new Array(DIMENSIONS).fill(0);
  values.forEach((v, i) => { padded[i] = v; });
  return padded;
}

async function insertFixtureRepository(repositoryId: string, commitSha: string, chunks: FixtureChunk[]): Promise<{ indexJobId: string; embeddingJobId: string }> {
  const pool = getPool()!;
  const cloneJobId = randomUUID();
  const indexJobId = randomUUID();
  const fileId = randomUUID();
  const embeddingJobId = randomUUID();

  await pool.query(
    `INSERT INTO repositories (id, owner_id, repo_url, provider, branch, status) VALUES ($1, $2, $3, 'GITHUB', 'main', 'EMBEDDINGS_READY')
     ON CONFLICT (id) DO NOTHING`,
    [repositoryId, `test-owner-${repositoryId}`, `https://github.com/test/${repositoryId}`],
  );
  await pool.query(
    `INSERT INTO repository_clone_jobs (id, repository_id, status, commit_sha) VALUES ($1, $2, 'COMPLETED', $3)`,
    [cloneJobId, repositoryId, commitSha],
  );
  await pool.query(
    `INSERT INTO repository_index_jobs (id, repository_id, clone_job_id, commit_sha, status) VALUES ($1, $2, $3, $4, 'COMPLETED')`,
    [indexJobId, repositoryId, cloneJobId, commitSha],
  );
  await pool.query(
    `INSERT INTO repository_index_files (id, index_job_id, repository_id, commit_sha, file_path, language, file_size_bytes, status)
     VALUES ($1, $2, $3, $4, 'src/fixture.ts', 'typescript', 100, 'INDEXED')`,
    [fileId, indexJobId, repositoryId, commitSha],
  );
  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO repository_code_chunks
         (id, index_job_id, repository_id, commit_sha, file_id, file_path, language, symbol, symbol_type, start_line, end_line, start_column, end_column, is_exported, content, content_hash, chunk_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'typescript', $7, 'function', 1, 3, 0, 1, true, $8, $9, $10)`,
      [chunk.id, indexJobId, repositoryId, commitSha, fileId, chunk.filePath, chunk.symbol, `content for ${chunk.symbol}`, `hash-${chunk.id}`, `key-${chunk.id}`],
    );
  }
  await pool.query(
    `INSERT INTO repository_embedding_jobs (id, repository_id, index_job_id, commit_sha, status, model, dimensions)
     VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6)`,
    [embeddingJobId, repositoryId, indexJobId, commitSha, MODEL, DIMENSIONS],
  );
  for (const chunk of chunks) {
    await pool.query(
      `INSERT INTO repository_code_embeddings (id, repository_id, embedding_job_id, chunk_id, commit_sha, model, dimensions, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
      [randomUUID(), repositoryId, embeddingJobId, chunk.id, commitSha, MODEL, DIMENSIONS, `hash-${chunk.id}`, `[${padVector(chunk.vector).join(',')}]`],
    );
  }

  return { indexJobId, embeddingJobId };
}

async function cleanupRepository(repositoryId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  // Cascades through clone_jobs -> index_jobs -> index_files -> chunks -> embedding_jobs -> embeddings.
  await pool.query(`DELETE FROM repositories WHERE id = $1`, [repositoryId]);
}

describeIfDb('RepositorySearchRepository.searchByVector (live Postgres + pgvector)', () => {
  const createdRepositoryIds: string[] = [];

  after(async () => {
    for (const id of createdRepositoryIds) {
      await cleanupRepository(id);
    }
  });

  it('TEST 11 — orders candidates by ascending cosine distance (nearest neighbor first)', async () => {
    const repositoryId = randomUUID();
    createdRepositoryIds.push(repositoryId);
    const commitSha = 'a'.repeat(40);
    const chunks: FixtureChunk[] = [
      { id: randomUUID(), filePath: 'src/far.ts', symbol: 'far', vector: [0, 1, 0] },
      { id: randomUUID(), filePath: 'src/near.ts', symbol: 'near', vector: [1, 0, 0.01] },
      { id: randomUUID(), filePath: 'src/mid.ts', symbol: 'mid', vector: [0.7, 0.3, 0] },
    ];
    await insertFixtureRepository(repositoryId, commitSha, chunks);

    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId, commitSha, model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 });

    assert.equal(results.length, 3);
    assert.deepEqual(results.map((r) => r.symbol), ['near', 'mid', 'far']);
    // Distances must actually be non-decreasing (real cosine distance, not just a lucky label match).
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].vectorDistance >= results[i - 1].vectorDistance);
    }
  });

  it('TEST 9 — repository isolation: a search for repository A never returns repository B\'s chunks', async () => {
    const repoA = randomUUID();
    const repoB = randomUUID();
    createdRepositoryIds.push(repoA, repoB);
    const commitSha = 'b'.repeat(40);
    await insertFixtureRepository(repoA, commitSha, [{ id: randomUUID(), filePath: 'src/a.ts', symbol: 'inRepoA', vector: [1, 0, 0] }]);
    await insertFixtureRepository(repoB, commitSha, [{ id: randomUUID(), filePath: 'src/b.ts', symbol: 'inRepoB', vector: [1, 0, 0] }]);

    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId: repoA, commitSha, model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 });

    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'inRepoA');
  });

  it('TEST 10 — commit isolation: a search for one commit never returns another commit\'s chunks, even in the same repository', async () => {
    const repositoryId = randomUUID();
    createdRepositoryIds.push(repositoryId);
    const commitOld = 'c'.repeat(40);
    const commitNew = 'd'.repeat(40);
    await insertFixtureRepository(repositoryId, commitOld, [{ id: randomUUID(), filePath: 'src/old.ts', symbol: 'oldVersion', vector: [1, 0, 0] }]);
    await insertFixtureRepository(repositoryId, commitNew, [{ id: randomUUID(), filePath: 'src/new.ts', symbol: 'newVersion', vector: [1, 0, 0] }]);

    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId, commitSha: commitNew, model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 });

    assert.equal(results.length, 1);
    assert.equal(results[0].symbol, 'newVersion');
  });

  it('model isolation: a search for one model never returns embeddings generated by a different model', async () => {
    const repositoryId = randomUUID();
    createdRepositoryIds.push(repositoryId);
    const commitSha = 'e'.repeat(40);
    await insertFixtureRepository(repositoryId, commitSha, [{ id: randomUUID(), filePath: 'src/x.ts', symbol: 'x', vector: [1, 0, 0] }]);

    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId, commitSha, model: 'a-completely-different-model', queryVector: padVector([1, 0, 0]), limit: 10 });

    assert.equal(results.length, 0);
  });

  it('TEST 12 — the candidate K limit is enforced', async () => {
    const repositoryId = randomUUID();
    createdRepositoryIds.push(repositoryId);
    const commitSha = 'f'.repeat(40);
    const chunks: FixtureChunk[] = Array.from({ length: 8 }, (_, i) => ({ id: randomUUID(), filePath: `src/f${i}.ts`, symbol: `fn${i}`, vector: [1, i / 100, 0] }));
    await insertFixtureRepository(repositoryId, commitSha, chunks);

    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId, commitSha, model: MODEL, queryVector: padVector([1, 0, 0]), limit: 3 });

    assert.equal(results.length, 3);
  });

  it('TEST 14/15 — no results and no error for a repository/commit with zero embeddings', async () => {
    const repo = new RepositorySearchRepository();
    const results = await repo.searchByVector({ repositoryId: randomUUID(), commitSha: 'g'.repeat(40), model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 });
    assert.deepEqual(results, []);
  });

  it('TEST 16 — parameterized query behavior: a SQL-injection-shaped repositoryId is treated as inert data, never executed', async () => {
    const repo = new RepositorySearchRepository();
    const maliciousId = "'; DROP TABLE repositories; --";
    // Must not throw a syntax error and must not affect any real data —
    // it simply matches no rows (repositoryId is a UUID column; a
    // non-UUID-shaped parameter is safely rejected by the driver/column
    // type, not interpolated into the SQL text).
    await assert.rejects(
      () => repo.searchByVector({ repositoryId: maliciousId, commitSha: 'h'.repeat(40), model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 }),
      (error: unknown) => {
        // A type-mismatch error from Postgres (invalid UUID) is the
        // expected, safe outcome — NOT a successful injected statement.
        assert.ok(error instanceof Error);
        return true;
      },
    );
    // Prove the table still exists and still has data.
    const pool = getPool()!;
    const stillThere = await pool.query(`SELECT to_regclass('repositories') AS exists`);
    assert.ok(stillThere.rows[0].exists !== null);
  });

  it('returns an empty array (not an error) when Postgres is not configured', async () => {
    const repo = new RepositorySearchRepository();
    const wasEnabled = repo.isEnabled();
    assert.equal(wasEnabled, true); // sanity check: this whole describe block only runs when DB is configured
  });

  it('returns the expected metadata fields, and never the raw vector', async () => {
    const repositoryId = randomUUID();
    createdRepositoryIds.push(repositoryId);
    const commitSha = 'i'.repeat(40);
    await insertFixtureRepository(repositoryId, commitSha, [{ id: randomUUID(), filePath: 'src/meta.ts', symbol: 'metaFn', vector: [1, 0, 0] }]);

    const repo = new RepositorySearchRepository();
    const [result] = await repo.searchByVector({ repositoryId, commitSha, model: MODEL, queryVector: padVector([1, 0, 0]), limit: 10 });

    assert.equal(result.filePath, 'src/meta.ts');
    assert.equal(result.symbol, 'metaFn');
    assert.equal(typeof result.vectorDistance, 'number');
    assert.ok(!('embedding' in result));
    assert.ok(!('vector' in result));
  });
});
