import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { startServer, buildDeps } from './server.js';
import { enqueueIndex, enqueueReview, normalizeRepoId } from './app.js';
import { parseRemote, repoIdOf } from './indexer/git.js';
import { answerQuestion } from './query/answer.js';
import { listPullStatuses, reviewPulls } from './review/pulls.js';
import { reviewPullRequest } from './review/reviewer.js';
import { identifiersFromCode } from './search/tokenize.js';
import { formatContext } from './search/retrieve.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ReviewCliArgs {
  repoId: string;
  prNumber?: number;
  all: boolean;
  post: boolean;
  force: boolean;
  fresh: boolean;
}

export function parseReviewArgs(args: string[]): ReviewCliArgs {
  const repoId = args[0] ?? '';
  const all = args.includes('--all');
  const parsedNumber = args[1] && args[1] !== '--all' ? Number(args[1]) : undefined;
  return { repoId, prNumber: Number.isFinite(parsedNumber) ? parsedNumber : undefined, all,
    post: args.includes('--post'), force: args.includes('--force'), fresh: args.includes('--fresh') };
}

type FreshReviewDeps = ReturnType<typeof buildDeps> & { verifierLlm?: ReturnType<typeof buildDeps>['llm'] };

export function freshReviewDeps(deps: FreshReviewDeps) {
  return {
    db: deps.db, llm: deps.llm, escalationLlm: deps.escalationLlm, verifierLlm: deps.verifierLlm,
    retrieve: deps.retrieve, github: deps.github, identifiers: identifiersFromCode,
    formatContext: (chunks: Parameters<typeof formatContext>[0]) => formatContext(chunks, 16000),
    statusContext: deps.config.review.statusContext, failOn: deps.config.review.failOn,
    maxRetries: deps.config.review.maxRetries, ignorePatterns: deps.config.review.ignorePatterns ?? [],
    publicUrl: deps.config.publicUrl,
  };
}

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
  repolens review <github:owner/name> <pr-number> [--post] [--force] [--fresh]
  repolens review <github:owner/name> --all [--post] [--force] [--fresh]`);
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

async function runFreshReview(deps: FreshReviewDeps, repoId: string, prNumber: number, post: boolean, force: boolean) {
  const started = Date.now();
  const result = await reviewPullRequest(freshReviewDeps(deps), { repoId, prNumber, post, force, fresh: true });
  const row = deps.db.getReview(result.reviewId);
  const stageModels = Object.fromEntries((result.trace?.stages ?? []).map((stage) => [
    stage.stage, [...new Set(stage.calls.map((call) => call.model))],
  ]));
  return {
    fixture: repoId,
    arm: 'fresh',
    headSha: result.headSha,
    stageModels,
    findings: result.findings,
    cost: row?.cost_usd ?? null,
    latencyMs: Date.now() - started,
    warnings: result.warnings,
    trace: result.trace,
    reviewId: result.reviewId,
    posted: result.posted,
  };
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
      let streamed = '';
      const result = await answerQuestion({
        llm: deps.chatLlm,
        retrieve: deps.retrieve,
        repoIds: [repoId],
        messages: [{ role: 'user', content: args.slice(1).join(' ') }],
        onDelta: (text) => {
          streamed += text;
          process.stdout.write(text);
        },
      });
      // The provider's final text is authoritative; only reprint if it differs.
      if (!streamed) {
        console.log(result.message);
      } else {
        process.stdout.write('\n');
        if (streamed.trim() !== result.message.trim()) {
          console.log('\n--- final answer ---');
          console.log(result.message);
        }
      }
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
      const parsed = parseReviewArgs(args);
      const post = parsed.post;
      const force = parsed.force;
      if (parsed.fresh) {
        if (parsed.all) {
          const pulls = await deps.github.listOpenPulls(deps.db.getRepo(repoId)!.owner, deps.db.getRepo(repoId)!.name);
          for (const pull of pulls) {
            if (pull.draft) continue;
            console.log(JSON.stringify(await runFreshReview(deps, repoId, pull.number, post, force)));
          }
          return;
        }
        if (parsed.prNumber === undefined) usage();
        console.log(JSON.stringify(await runFreshReview(deps, repoId, parsed.prNumber, post, force)));
        return;
      }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]).href)) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
