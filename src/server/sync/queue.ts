import type { DB } from '../db.js';
import { log, scrubString } from '../logger.js';
import { HubSpotApiError } from '../hubspot/client.js';

export type JobHandler = (payload: any, job: { id: number; instanceId: string | null; attempts: number }) => Promise<void>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_ATTEMPTS = 8;

/**
 * Durable SQLite-backed job queue.
 * - Webhook handlers only enqueue and return 200 fast (HubSpot/Wix time out otherwise).
 * - `dedupeKey` collapses bursts: HubSpot sends one webhook per changed property,
 *   so N property changes on one contact become a single reconcile job.
 * - Failures retry with exponential backoff (honouring HubSpot's Retry-After), then go "dead".
 */
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private db: DB) {
    // Jobs that were mid-flight when the process died are retried.
    db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
  }

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: unknown, opts: { instanceId?: string; dedupeKey?: string; delayMs?: number } = {}) {
    this.db
      .prepare(
        `INSERT INTO jobs (type, instance_id, dedupe_key, payload, run_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(type, opts.instanceId ?? null, opts.dedupeKey ?? null, JSON.stringify(payload), Date.now() + (opts.delayMs ?? 0), Date.now());
    this.kick();
  }

  start(intervalMs = 250) {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    if (this.running) return;
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
    });
  }

  /** Resolves once no job is running or due within `horizonMs` (used by tests and the dev stack). */
  async idle(timeoutMs = 10_000, horizonMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = Number((this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('pending','running') AND run_at <= ?").get(Date.now() + horizonMs) as { n: number }).n);
      if (!this.running && n === 0) return;
      this.kick();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('queue did not become idle');
  }

  private async drain() {
    for (;;) {
      const job = this.db
        .prepare(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1
           WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1)
           RETURNING id, type, instance_id, dedupe_key, payload, attempts`,
        )
        .get(Date.now()) as { id: number; type: string; instance_id: string | null; dedupe_key: string | null; payload: string; attempts: number } | undefined;
      if (!job) return;

      const handler = this.handlers.get(job.type);
      try {
        if (!handler) throw new Error(`no handler for ${job.type}`);
        await handler(JSON.parse(job.payload), { id: job.id, instanceId: job.instance_id, attempts: job.attempts });
        this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
      } catch (err) {
        const permanent = err instanceof HubSpotApiError && !err.retryable && err.status !== 401;
        const dead = permanent || job.attempts >= MAX_ATTEMPTS;
        const backoff = err instanceof HubSpotApiError && err.retryAfterMs ? err.retryAfterMs : Math.min(2 ** job.attempts * 1000, 15 * 60_000);
        log.warn('job failed', { jobType: job.type, instanceId: job.instance_id, attempt: job.attempts, dead, err });
        // A newer pending job with the same key will re-read the latest state anyway.
        const superseded = !dead && job.dedupe_key && this.db.prepare("SELECT 1 FROM jobs WHERE dedupe_key = ? AND status = 'pending'").get(job.dedupe_key);
        if (superseded) {
          this.db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
        } else {
          this.db
            .prepare('UPDATE jobs SET status = ?, run_at = ?, last_error = ?, dedupe_key = CASE WHEN ? THEN NULL ELSE dedupe_key END WHERE id = ?')
            .run(dead ? 'dead' : 'pending', Date.now() + backoff, scrubString(String((err as Error).message ?? err)).slice(0, 500), dead ? 1 : 0, job.id);
        }
      }
    }
  }
}
