/**
 * Formats a USDC amount string to a human-readable string with 2 decimal places.
 *
 * @param amount - Decimal string (e.g. "500.0000000" or "500").
 * @returns Amount formatted to 2 decimal places (e.g. "500.00").
 */
export function formatUSDC(amount: string): string {
  const num = parseFloat(amount);
  if (isNaN(num)) {
    throw new Error(`Invalid USDC amount: "${amount}"`);
  }
  return num.toFixed(2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristically distinguishes a transport/network-level failure (RPC
 * unreachable, connection reset, request timeout) from every other kind of
 * rejection (issue #142) — the RPC layer only auto-retries the former.
 * There's no single error shape shared by every environment's `fetch`
 * (browser vs Node's undici) or every possible network stack failure, so
 * this matches on the common signatures rather than a specific type.
 */
export function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) {
    // fetch's own network-failure signature in both the browser ("Failed to
    // fetch") and Node/undici ("fetch failed").
    return true;
  }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /network|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(
    message,
  );
}

/** Narrower check for specifically a timeout, vs. an outright unreachable endpoint — used to pick RpcTimeoutError vs RpcUnavailableError. */
export function isTimeoutError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

export interface RetryWithBackoffOptions {
  /** Total number of attempts, including the first — default 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only errors this returns true for trigger a retry; anything else rejects immediately. Defaults to retrying everything. */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Retries `fn` with exponential backoff and full jitter (issue #142).
 * Non-retryable errors (per `isRetryable`) and the final attempt's error
 * both reject immediately — this never swallows a permanent failure.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryWithBackoffOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 3_000;
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      // Full jitter: uniform in [0, exponential] rather than a fixed
      // fraction of it, so concurrent callers retrying the same transient
      // outage don't stay synchronized on each other's backoff schedule.
      await sleep(Math.random() * exponential);
    }
  }
  throw lastError;
}
