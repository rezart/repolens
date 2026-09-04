export interface EmbeddingProvider {
  readonly model: string;
  /** Dimension of returned vectors; null until the first call succeeds. */
  readonly dimension: number | null;
  embed(texts: string[]): Promise<number[][]>;
}
