/**
 * Repository Worker — future interface for Git → Tree-sitter → BGE-M3 → pgvector pipeline.
 */
export interface RepositoryIndexRequest {
  repoUrl: string;
  branch?: string;
}

export interface RepositoryChunk {
  path: string;
  type: 'function' | 'class' | 'component' | 'route' | 'config';
  content: string;
  startLine: number;
  endLine: number;
}

export interface RepositoryMap {
  repoUrl: string;
  chunks: RepositoryChunk[];
  indexedAt: string;
}

export class RepoWorker {
  async index(_request: RepositoryIndexRequest): Promise<RepositoryMap> {
    throw new Error('Repository indexing not implemented in current MVP scope.');
  }

  async search(_query: string, _repoUrl: string): Promise<RepositoryChunk[]> {
    throw new Error('Repository search not implemented in current MVP scope.');
  }
}
