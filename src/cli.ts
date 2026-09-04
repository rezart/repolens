import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { startServer, buildDeps } from './server.js';
import { enqueueIndex, enqueueReview, normalizeRepoId } from './app.js';
import { parseRemote } from './indexer/git.js';
import { answerQuestion } from './query/answer.js';

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function usage(): never {
  console.error(`Usage:
  repolens serve
  repolens index <owner/name | url> [--branch <b>]
  repolens ask <github:owner/name> "<question>"
  repolens review <github:owner/name> <pr-number> [--post] [--force]`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const log = (m: string) => console.error(`[repolens] ${m}`);

  switch (cmd) {
    case 'serve': {
      startServer(config, log);
      return;
    }
    case 'index': {
      if (!args[0]) usage();
      const deps = buildDeps(config, log);
      const parsed = parseRemote(args[0]);
      const id = `github:${parsed.owner}/${parsed.name}`;
      // '' means "use the remote's default branch"; the index job resolves it.
      deps.db.upsertRepo({ id, remote: parsed.url, owner: parsed.owner, name: parsed.name, branch: flag(args, '--branch') ?? '' });
      const job = enqueueIndex(deps, id);
      await deps.jobs.idle();
      const done = deps.db.getJob(job.id)!;
      if (done.status === 'error') throw new Error(done.error ?? 'index failed');
      console.log(JSON.stringify({ repository: deps.db.getRepo(id), result: JSON.parse(done.result_json ?? 'null') }, null, 2));
      return;
    }
    case 'ask': {
      if (!args[0] || !args[1]) usage();
      const deps = buildDeps(config, log);
      const repoId = normalizeRepoId(args[0]);
      if (!deps.db.getRepo(repoId)) throw new Error(`${repoId} is not indexed; run: repolens index ${args[0]}`);
      const result = await answerQuestion({
        llm: deps.llm,
        retrieve: deps.retrieve,
        repoIds: [repoId],
        messages: [{ role: 'user', content: args.slice(1).join(' ') }],
      });
      console.log(result.message);
      if (result.sources.length) {
        console.log('\nSources:');
        for (const s of result.sources) console.log(`  ${s.filepath}:${s.linestart}-${s.lineend}`);
      }
      return;
    }
    case 'review': {
      if (!args[0] || !args[1]) usage();
      const deps = buildDeps(config, log);
      const repoId = normalizeRepoId(args[0]);
      if (!deps.db.getRepo(repoId)) throw new Error(`${repoId} is not indexed; run: repolens index first`);
      const job = enqueueReview(deps, repoId, Number(args[1]), { post: args.includes('--post'), force: args.includes('--force') });
      await deps.jobs.idle();
      const done = deps.db.getJob(job.id)!;
      if (done.status === 'error') throw new Error(done.error ?? 'review failed');
      const result = JSON.parse(done.result_json ?? '{}') as { reviewId: number };
      const review = deps.db.getReview(result.reviewId)!;
      console.log(`## Verdict: ${review.verdict}\n\n${review.summary}\n`);
      for (const f of JSON.parse(review.comments_json) as Array<{ path: string; line: number; severity: string; title: string; body: string }>) {
        console.log(`- [${f.severity}] ${f.path}:${f.line} — ${f.title}\n  ${f.body.replace(/\n/g, '\n  ')}`);
      }
      if (review.posted) console.log('\nPosted to GitHub.');
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
