import { describe, expect, it } from 'vitest';
import { buildHistoricalContext, type HistoricalSources } from '../../src/review/history.js';

describe('buildHistoricalContext', () => {
  it('finds merged PRs for changed paths and carries prior RepoLens findings', async () => {
    const calls: string[] = [];
    const sources: HistoricalSources = {
      listPathCommits: async (path, ref) => {
        calls.push(`commits:${path}@${ref}`);
        return [{ sha: 'abc1234', message: 'old change' }];
      },
      listCommitPulls: async (sha) => {
        calls.push(`pulls:${sha}`);
        return [{
          number: 7,
          title: 'Old fix',
          body: 'Description',
          htmlUrl: 'https://github.com/o/r/pull/7',
          mergedAt: '2025-01-01T00:00:00Z',
          repository: 'o/r',
        }];
      },
      findLatestReview: () => ({
        comments_json: JSON.stringify([{ path: 'src/new.ts', line: 8, severity: 'warning', title: 'Old issue', body: 'Check this.' }]),
      }),
    };

    const result = await buildHistoricalContext(sources, {
      paths: ['src/old.ts', 'src/new.ts'],
      baseSha: 'base',
      currentPrNumber: 42,
      repository: 'o/r',
    });

    expect(calls).toEqual(['commits:src/old.ts@base', 'pulls:abc1234', 'commits:src/new.ts@base']);
    expect(result.byPath.get('src/new.ts')?.[0]).toMatchObject({
      number: 7,
      commitSha: 'abc1234',
      findings: [{ path: 'src/new.ts', title: 'Old issue' }],
    });
    expect(result.byPath.get('src/old.ts')?.[0]?.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('skips unmerged, current, and cross-repository PRs and warns on fetch failures', async () => {
    const sources: HistoricalSources = {
      listPathCommits: async () => { throw new Error('history unavailable'); },
      listCommitPulls: async () => [],
      findLatestReview: () => undefined,
    };
    const result = await buildHistoricalContext(sources, {
      paths: ['src/a.ts'], baseSha: 'base', currentPrNumber: 42, repository: 'o/r',
    });
    expect(result.byPath.size).toBe(0);
    expect(result.warnings.join('\n')).toContain('history unavailable');
  });

  it('filters unmerged, current, and cross-repository associated PRs', async () => {
    const result = await buildHistoricalContext({
      listPathCommits: async () => [{ sha: 'abc1234', message: '' }],
      listCommitPulls: async () => [
        { number: 1, title: 'open', body: '', htmlUrl: '', mergedAt: null, repository: 'o/r' },
        { number: 42, title: 'current', body: '', htmlUrl: '', mergedAt: '2025-01-01', repository: 'o/r' },
        { number: 2, title: 'fork', body: '', htmlUrl: '', mergedAt: '2025-01-01', repository: 'other/r' },
        { number: 3, title: 'merged', body: '', htmlUrl: 'https://github.com/o/r/pull/3', mergedAt: '2025-01-01', repository: 'o/r' },
      ],
      findLatestReview: () => undefined,
    }, { paths: ['src/a.ts'], baseSha: 'base', currentPrNumber: 42, repository: 'o/r' });
    expect(result.byPath.get('src/a.ts')?.map((p) => p.number)).toEqual([3]);
  });

  it('warns on DB failures while preserving the historical context', async () => {
    const result = await buildHistoricalContext({
      listPathCommits: async () => [{ sha: 'abc1234', message: '' }],
      listCommitPulls: async () => [{ number: 3, title: 'merged', body: '', htmlUrl: 'https://github.com/o/r/pull/3', mergedAt: '2025-01-01', repository: 'o/r' }],
      findLatestReview: () => { throw new Error('db unavailable'); },
    }, { paths: ['src/a.ts'], baseSha: 'base', currentPrNumber: 42, repository: 'o/r' });
    expect(result.byPath.get('src/a.ts')?.[0]?.findings).toEqual([]);
    expect(result.warnings.join('\n')).toContain('db unavailable');
  });

  it('filters findings by the reviewed path before applying the findings cap', async () => {
    const result = await buildHistoricalContext({
      listPathCommits: async () => [{ sha: 'abc1234', message: '' }],
      listCommitPulls: async () => [{ number: 3, title: 'merged', body: '', htmlUrl: 'https://github.com/o/r/pull/3', mergedAt: '2025-01-01', repository: 'o/r' }],
      findLatestReview: () => ({ comments_json: JSON.stringify([
        ...Array.from({ length: 9 }, (_, i) => ({ path: `src/other${i}.ts`, line: i + 1, severity: 'warning', title: `Other ${i}` })),
        { path: 'src/a.ts', line: 10, severity: 'critical', title: 'Relevant' },
      ]) }),
    }, { paths: ['src/a.ts'], baseSha: 'base', currentPrNumber: 42, repository: 'o/r' });
    expect(result.byPath.get('src/a.ts')?.[0]?.findings.map((f) => f.title)).toEqual(['Relevant']);
  });

  it('warns and continues when the commit to PR lookup fails', async () => {
    const result = await buildHistoricalContext({
      listPathCommits: async () => [{ sha: 'abc1234', message: '' }],
      listCommitPulls: async () => { throw new Error('pull lookup unavailable'); },
      findLatestReview: () => undefined,
    }, { paths: ['src/a.ts'], baseSha: 'base', currentPrNumber: 42, repository: 'o/r' });
    expect(result.byPath.size).toBe(0);
    expect(result.warnings.join('\n')).toContain('pull lookup unavailable');
  });

  it('bounds path and associated commit requests and returned PRs', async () => {
    const pathCalls: string[] = [];
    const pullCalls: string[] = [];
    const result = await buildHistoricalContext({
      listPathCommits: async (path) => {
        pathCalls.push(path);
        return Array.from({ length: 3 }, (_, i) => ({ sha: `${path}-${i}`, message: '' }));
      },
      listCommitPulls: async (sha) => {
        pullCalls.push(sha);
        return [{ number: pullCalls.length, title: `PR ${pullCalls.length}`, body: '', htmlUrl: `https://github.com/o/r/pull/${pullCalls.length}`, mergedAt: '2025-01-01', repository: 'o/r' }];
      },
      findLatestReview: () => undefined,
    }, { paths: Array.from({ length: 20 }, (_, i) => `src/${i}.ts`), baseSha: 'base', currentPrNumber: 42, repository: 'o/r' });
    expect(pathCalls).toHaveLength(8);
    expect(pullCalls.length).toBeLessThanOrEqual(12);
    expect(new Set([...result.byPath.values()].flat().map((p) => p.number)).size).toBeLessThanOrEqual(3);
  });
});
