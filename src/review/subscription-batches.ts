/** Complete files only: never truncate a diff or approve an unreviewed remainder. */
export function subscriptionBatches<T>(files: T[], requestBytes: (files: T[]) => number,
  maxFiles = 40, maxBytes = 256 * 1024): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const file of files) {
    const candidate = [...batch, file];
    if (candidate.length > maxFiles || requestBytes(candidate) > maxBytes) {
      if (batch.length) batches.push(batch);
      batch = [file];
      if (requestBytes(batch) > maxBytes) {
        throw new Error('Review file exceeds the private broker input limit; split this pull request.');
      }
    } else batch = candidate;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
