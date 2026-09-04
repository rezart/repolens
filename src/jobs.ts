import type { Db, JobKind, JobRow } from './db.js';

export interface JobContext {
  progress: (message: string) => void;
}

type JobFn = (ctx: JobContext) => Promise<unknown>;

export interface JobMeta {
  /** Pull request the job is about; lets the API tell which PRs have a review in flight. */
  prNumber?: number;
}

/**
 * In-process job queue. Jobs of the same kind run one at a time in FIFO order;
 * different kinds run independently. State is persisted in the `jobs` table so
 * the API can report progress.
 */
export class JobQueue {
  private queues = new Map<JobKind, Array<{ id: number; fn: JobFn }>>();
  private running = new Set<JobKind>();

  constructor(
    private readonly db: Db,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  enqueue(kind: JobKind, repoId: string | null, fn: JobFn, meta: JobMeta = {}): JobRow {
    const job = this.db.createJob(kind, repoId, meta.prNumber ?? null);
    const q = this.queues.get(kind) ?? [];
    q.push({ id: job.id, fn });
    this.queues.set(kind, q);
    void this.drain(kind).catch((err: unknown) => {
      this.log(`job queue (${kind}) drain failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return job;
  }

  /** Resolves when every queued job of every kind has finished. Useful in tests and the CLI. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || [...this.queues.values()].some((q) => q.length > 0)) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private async drain(kind: JobKind) {
    if (this.running.has(kind)) return;
    this.running.add(kind);
    try {
      for (;;) {
        const next = this.queues.get(kind)?.shift();
        if (!next) break;
        await this.runOne(kind, next.id, next.fn);
      }
    } finally {
      this.running.delete(kind);
    }
  }

  private async runOne(kind: JobKind, id: number, fn: JobFn) {
    try {
      // Inside the try: a failing status write must mark the job as errored, not
      // escape into drain() and stall the queue.
      this.db.updateJob(id, { status: 'running' });
      this.log(`job ${id} (${kind}) started`);
      const result = await fn({ progress: (m) => this.db.updateJob(id, { progress: m }) });
      this.db.updateJob(id, { status: 'done', result_json: result === undefined ? null : JSON.stringify(result) });
      this.log(`job ${id} (${kind}) done`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db.updateJob(id, { status: 'error', error: message });
      this.log(`job ${id} (${kind}) failed: ${message}`);
    }
  }
}
