/**
 * Exponential-backoff job poller with a 30-second sync window.
 *
 * Per CEO D9 + D14 + Eng E4:
 *   - Up to 30 seconds: poll the job synchronously, return assets when complete.
 *   - Beyond 30 seconds: hand off — return `{ jobId, statusUrl }` and let the
 *     calling LLM follow up via the `pixeldojo_status` tool.
 *   - Backoff sequence: 1s → 2s → 4s → 8s → 8s → 8s ... capped at 8s.
 *     Halves load on /api/v1/jobs/{id} vs a flat 2s interval.
 *
 * Job-fetcher and clock are dependency-injected so the unit tests can
 * exercise every branch without spinning a real HTTP fetcher or sleeping
 * for real wall-clock time.
 */

export interface PollableJob {
  jobId: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | string;
  assets?: Array<{ url: string; type?: string }>;
  output?: unknown;
  /** Provider-side error if the job failed. */
  error?: { code?: string; message?: string } | string;
}

export interface PollOptions {
  /** Hard cap on the synchronous wait window. Default: 30_000 ms (per D9). */
  syncBudgetMs?: number;
  /** Override the backoff sequence. Default: [1000, 2000, 4000, 8000]. */
  backoffSequenceMs?: number[];
  /** Cap on the recurring delay once the sequence is exhausted. */
  maxIntervalMs?: number;
  /** Inject a clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Inject a sleeper for tests. Defaults to setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional abort signal — caller can cancel a poll mid-flight. */
  signal?: AbortSignal;
}

export type PollResult =
  | { kind: 'completed'; job: PollableJob }
  | { kind: 'failed'; job: PollableJob }
  | { kind: 'handoff'; jobId: string; statusUrl: string };

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000];
const DEFAULT_MAX_INTERVAL = 8000;
const DEFAULT_SYNC_BUDGET_MS = 30_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll a job to terminal state OR until the sync budget is exhausted.
 * `fetchJob` returns the latest job snapshot; the poller decides when to
 * call it next.
 */
export async function pollJobUntilDoneOrHandoff(
  jobId: string,
  fetchJob: (id: string) => Promise<PollableJob>,
  buildStatusUrl: (id: string) => string,
  options: PollOptions = {},
): Promise<PollResult> {
  const {
    syncBudgetMs = DEFAULT_SYNC_BUDGET_MS,
    backoffSequenceMs = DEFAULT_BACKOFF,
    maxIntervalMs = DEFAULT_MAX_INTERVAL,
    now = Date.now,
    sleep = (ms) => defaultSleep(ms, options.signal),
    signal,
  } = options;

  const start = now();
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    const job = await fetchJob(jobId);

    if (job.status === 'completed') return { kind: 'completed', job };
    if (job.status === 'failed') return { kind: 'failed', job };

    const elapsed = now() - start;
    const remaining = syncBudgetMs - elapsed;
    if (remaining <= 0) {
      return {
        kind: 'handoff',
        jobId,
        statusUrl: buildStatusUrl(jobId),
      };
    }

    const interval =
      attempt < backoffSequenceMs.length ? backoffSequenceMs[attempt] : maxIntervalMs;
    // Don't sleep past the sync deadline — clamp the wait so the next
    // iteration immediately enters the "remaining <= 0" branch.
    const wait = Math.min(interval, Math.max(remaining, 0));
    if (wait > 0) await sleep(wait);
    attempt++;
  }
}
