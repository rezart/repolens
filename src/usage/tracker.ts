import { reviewCallCost } from './review-cost.js';
import type { Db, UsageDayRow } from '../db.js';
import { OpenRouterPricing } from './pricing.js';
import type { PriceList } from './pricing.js';
import type { UsageRole, UsageSink } from './types.js';

/** One UTC day of calls for a role/provider/model, with costs resolved. */
export interface UsageReportRow {
  day: string;
  role: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Sum of the costs the backends reported themselves. */
  reportedCostUsd: number;
  /** List-price estimate for the calls that reported no cost; null when no price resolved. */
  estimatedCostUsd: number | null;
  /** Reported plus estimated; null when nothing in the row could be priced at all. */
  costUsd: number | null;
  /** False when some calls in the row could not be priced, so the cost is a floor. */
  priced: boolean;
}

export interface UsageReport {
  days: number;
  /** Start of the window, an ISO timestamp in UTC: exactly `days` before now. */
  since: string;
  pricing: { fetchedAt: string | null; error: string | null };
  rows: UsageReportRow[];
}

export interface UsageTrackerOptions {
  db: Db;
  /** Null disables list-price estimation; only reported costs are shown. */
  pricing: OpenRouterPricing | null;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

const DAY_MS = 86_400_000;

/**
 * Records what every backend call cost and reports it per day. Providers hand it
 * a sink; the sink writes one row per call and must never fail the call it is
 * billing, so a storage error is logged and dropped.
 */
export class UsageTracker {
  private readonly db: Db;
  private readonly pricing: OpenRouterPricing | null;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(opts: UsageTrackerOptions) {
    this.db = opts.db;
    this.pricing = opts.pricing;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** The callback handed to a provider for one role. */
  sinkFor(role: UsageRole): UsageSink {
    return (record) => {
      const cost = role === 'review' ? reviewCallCost.getStore() : undefined;
      if (cost) {
        cost.reported = true;
        const next = cost.costUsd !== null && typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) && record.costUsd >= 0
          ? cost.costUsd + record.costUsd
          : null;
        cost.costUsd = next !== null && Number.isFinite(next) ? next : null;
      }
      try {
        this.db.insertUsage({
          role,
          provider: record.provider,
          model: record.model,
          input_tokens: record.inputTokens,
          cached_input_tokens: record.cachedInputTokens,
          cache_write_tokens: record.cacheWriteTokens,
          output_tokens: record.outputTokens,
          cost_usd: record.costUsd,
        });
      } catch (err) {
        this.log(`usage: failed to record ${role} call: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  async report(days: number): Promise<UsageReport> {
    // Rows are grouped by UTC day, so the window opens at UTC midnight `days - 1`
    // days ago: today plus the previous whole days, never a partial oldest day.
    const since = new Date(startOfUtcDay(this.now()) - (days - 1) * DAY_MS).toISOString();
    const rows = this.db.usageByDay(since);
    // A missing price list is not an error the report can fail on: rows still
    // carry whatever costs the backends reported themselves.
    const { list, error } = this.pricing ? await this.pricing.ensure() : { list: null, error: 'pricing disabled' };
    return {
      days,
      since,
      pricing: { fetchedAt: list?.fetchedAt ?? null, error },
      rows: rows.map((row) => priceRow(row, list)),
    };
  }
}

function priceRow(row: UsageDayRow, list: PriceList | null): UsageReportRow {
  const estimatedCostUsd = estimateUnpriced(row, list);
  return {
    day: row.day,
    role: row.role,
    provider: row.provider,
    model: row.model,
    calls: row.calls,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    reportedCostUsd: row.reported_cost_usd,
    estimatedCostUsd,
    costUsd:
      estimatedCostUsd === null
        ? // Nothing to add: show the reported total (even a free model's 0) as long as
          // at least one call in the row was priced by its backend.
          row.calls > row.unpriced_calls
          ? row.reported_cost_usd
          : null
        : row.reported_cost_usd + estimatedCostUsd,
    priced: row.unpriced_calls === 0 || estimatedCostUsd !== null,
  };
}

function startOfUtcDay(ms: number): number {
  return ms - (ms % DAY_MS);
}

/** Zero when every call reported its own cost, null when no list price resolves. */
function estimateUnpriced(row: UsageDayRow, list: PriceList | null): number | null {
  if (row.unpriced_calls === 0) return 0;
  const price = list ? OpenRouterPricing.resolve(list, row.provider, row.model) : null;
  if (!price) return null;
  return OpenRouterPricing.estimate(price, {
    inputTokens: row.unpriced_input_tokens,
    cachedInputTokens: row.unpriced_cached_input_tokens,
    cacheWriteTokens: row.unpriced_cache_write_tokens,
    outputTokens: row.unpriced_output_tokens,
  });
}
