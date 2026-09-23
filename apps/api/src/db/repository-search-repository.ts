import { getPool } from './pool.js';

export interface VectorSearchCandidate {
  chunkId: string;
  filePath: string;
  language: string;
  symbol: string;
  symbolType: string;
  parentSymbol: string | null;
  startLine: number;
  endLine: number;
  isExported: boolean;
  content: string;
  /** pgvector cosine distance (`<=>`) — lower is more similar. */
  vectorDistance: number;
}

export interface VectorSearchParams {
  repositoryId: string;
  commitSha: string;
  model: string;
  queryVector: number[];
  limit: number;
}

/**
 * The only place in this feature that talks to pgvector directly. Every
 * value that could ever be attacker- or user-influenced (repositoryId,
 * commitSha, model, the query vector itself, limit) is passed as a real
 * query parameter — never string-interpolated into the SQL text. The query
 * vector is the one exception that can't be a plain `$n` parameter as a
 * JS array (pg has no native vector type binding), so it is formatted as a
 * pgvector literal string (`[0.1,0.2,...]`) and passed as a parameter,
 * then cast with `::vector` in SQL — the literal is built from `Array.join`
 * over floating-point numbers only, never from any string a caller
 * supplies, so it can't smuggle SQL.
 */
export class RepositorySearchRepository {
  isEnabled(): boolean {
    return getPool() !== null;
  }

  async searchByVector(params: VectorSearchParams): Promise<VectorSearchCandidate[]> {
    const pool = getPool();
    if (!pool) return [];

    const vectorLiteral = toVectorLiteral(params.queryVector);
    const result = await pool.query(
      `SELECT
         e.chunk_id AS chunk_id,
         c.file_path,
         c.language,
         c.symbol,
         c.symbol_type,
         c.parent_symbol,
         c.start_line,
         c.end_line,
         c.is_exported,
         c.content,
         (e.embedding <=> $1::vector) AS vector_distance
       FROM repository_code_embeddings e
       JOIN repository_code_chunks c ON c.id = e.chunk_id
       WHERE e.repository_id = $2 AND e.commit_sha = $3 AND e.model = $4
       ORDER BY e.embedding <=> $1::vector
       LIMIT $5`,
      [vectorLiteral, params.repositoryId, params.commitSha, params.model, params.limit],
    );

    return (result.rows as Record<string, unknown>[]).map((row) => ({
      chunkId: row.chunk_id as string,
      filePath: row.file_path as string,
      language: row.language as string,
      symbol: row.symbol as string,
      symbolType: row.symbol_type as string,
      parentSymbol: (row.parent_symbol as string) ?? null,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
      isExported: row.is_exported as boolean,
      content: row.content as string,
      vectorDistance: Number(row.vector_distance),
    }));
  }
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
