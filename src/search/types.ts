export interface RetrievedChunk {
  chunkId: number;
  repoId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface RetrieveRequest {
  repoIds: string[];
  query: string;
  limit?: number;
  /** Chunks whose path equals this are excluded (used by the reviewer to avoid echoing the file under review). */
  excludePath?: string;
  /**
   * Chunks whose path is in this list are excluded. The reviewer passes every path
   * the pull request touches: index chunks for those files are stale by definition.
   */
  excludePaths?: string[];
}

export type RetrieveFn = (req: RetrieveRequest) => Promise<RetrievedChunk[]>;
