import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { startServer, buildDeps } from './server.js';
import { enqueueIndex, enqueueReview, normalizeRepoId } from './app.js';
import { parseRemote, repoIdOf } from './indexer/git.js';
import { answerQuestion } from './query/answer.js';
import { listPullStatuses, reviewPulls } from './review/pulls.js';

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
  repolens index <owner/name | github url | local path> [--branch <b>]
  repolens ask <github:owner/name | local:name> "<question>"
  repolens pulls <github:owner/name>
  repolens review <github:owner/name> <pr-number> [--post] [--force]
  repolens review <github:owner/name> --all [--post] [--force]`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Left-aligned columns; the last one is not padded so it can be any width. */
function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
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
      const id = repoIdOf(parsed);
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
      // Stream straight to stdout so the answer appears as it is generated.
      let streamed = false;
      const result = await answerQuestion({
        llm: deps.chatLlm,
        retrieve: deps.retrieve,
        repoIds: [repoId],
        messages: [{ role: 'user', content: args.slice(1).join(' ') }],
        onDelta: (text) => {
          streamed = true;
          process.stdout.write(text);
        },
      });
      // The provider's final text is authoritative; only reprint if it differs.
      if (streamed) process.stdout.write('\n');
      else console.log(result.message);
      if (result.sources.length) {
        console.log('\nSources:');
        for (const s of result.sources) console.log(`  ${s.filepath}:${s.linestart}-${s.lineend}`);
      }
      return;
    }
    case 'pulls': {
      if (!args[0]) usage();
      const deps = buildDeps(config, log);
      const repoId = normalizeRepoId(args[0]);
      if (!deps.db.getRepo(repoId)) throw new Error(`${repoId} is not indexed; run: repolens index ${args[0]}`);
      const pulls = await listPullStatuses(deps, repoId);
      if (!pulls.length) {
        console.log('No open pull requests.');
        return;
      }
      printTable(
        ['PR', 'STATUS', 'VERDICT', 'FINDINGS', 'TITLE'],
        pulls.map((p) => [
          `#${p.number}`,
          p.review.status,
          p.review.verdict ?? '-',
          p.review.findings === undefined ? '-' : String(p.review.findings),
          p.draft ? `${p.title} (draft)` : p.title,
        ]),
      );
      return;
    }
    case 'review': {
      if (!args[0]) usage();
      const deps = buildDeps(config, log);
      const repoId = normalizeRepoId(args[0]);
      if (!deps.db.getRepo(repoId)) throw new Error(`${repoId} is not indexed; run: repolens index first`);
      const post = args.includes('--post');
      const force = args.includes('--force');
      if (args.includes('--all')) {
        const pulls = await listPullStatuses(deps, repoId);
        const out = reviewPulls(deps, repoId, { post, force, pulls });
        for (const s of out.skipped) console.log(`#${s.prNumber} skipped (${s.reason})`);
        if (!out.jobs.length) {
          console.log('Nothing to review.');
          return;
        }
        await deps.jobs.idle();
        for (const j of out.jobs) {
          const done = deps.db.getJob(j.jobId)!;
          if (done.status === 'error') {
            console.log(`#${j.prNumber} failed: ${done.error ?? 'review failed'}`);
            continue;
          }
          const result = JSON.parse(done.result_json ?? '{}') as { reviewId?: number; findings?: number; posted?: boolean };
          const review = result.reviewId ? deps.db.getReview(result.reviewId) : undefined;
          console.log(
            `#${j.prNumber} ${review?.verdict ?? 'unknown'} — ${result.findings ?? 0} finding(s)${result.posted ? ', posted to GitHub' : ''}`,
          );
        }
        return;
      }
      if (!args[1]) usage();
      const job = enqueueReview(deps, repoId, Number(args[1]), { post, force });
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
