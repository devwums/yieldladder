import type { IntentStatus } from '../lib/paymentIntent';
import type { RetryClassification } from '../lib/retryClassification';

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  'https://soroban-testnet.stellar.org';

let _seq = 0;

/**
 * The RPC endpoint could not be reached at all (DNS failure, connection
 * refused, offline) or responded with a transient server-side error
 * (429/5xx) — distinct from a timeout, where a connection was established
 * but no response arrived in time. Raised only after `callRpc`'s own
 * retry-with-backoff (issue #142) has exhausted its attempts.
 */
export class RpcUnavailableError extends Error {
  readonly retryClassification: RetryClassification = 'retryable-safely';
  constructor(readonly rawError: string) {
    super('Could not reach the Soroban RPC endpoint.');
    this.name = 'RpcUnavailableError';
  }
}

/** An RPC request was sent but no response arrived before the deadline. Raised only after retries are exhausted. */
export class RpcTimeoutError extends Error {
  readonly retryClassification: RetryClassification = 'retryable-safely';
  constructor(readonly rawError: string) {
    super('The Soroban RPC endpoint did not respond in time.');
    this.name = 'RpcTimeoutError';
  }
}

class TransientHttpError extends Error {
  constructor(readonly status: number) {
    super(`Soroban RPC HTTP ${status}`);
    this.name = 'TransientHttpError';
  }
}

function isTimeoutMessage(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

/**
 * Distinguishes a transient transport/server failure — worth retrying —
 * from everything else (a JSON-RPC error the server deliberately returned,
 * a malformed request, etc.), which must fail immediately instead of being
 * silently retried into a misleading "RPC unreachable" message.
 */
function isRetryableRpcError(error: unknown): boolean {
  if (error instanceof TransientHttpError) return true;
  if (error instanceof TypeError) return true; // fetch's own network-failure signature
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  const message = error instanceof Error ? error.message : String(error);
  return /network|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(
    message,
  );
}

const MAX_RPC_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 3_000;

async function callRpcOnce<T>(method: string, params: unknown[]): Promise<T> {
  // A thrown `fetch` rejection (network failure, no response at all)
  // propagates as-is — isRetryableRpcError below classifies it (a
  // TypeError) the same way it classifies a transient HTTP status.
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_seq, method, params }),
    cache: 'no-store',
  });

  if (res.status === 429 || res.status >= 500) {
    throw new TransientHttpError(res.status);
  }
  if (!res.ok) throw new Error(`Soroban RPC HTTP ${res.status}`);

  const json = (await res.json()) as {
    result?: T;
    error?: { message: string };
  };

  if (json.error) throw new Error(json.error.message);
  if (json.result === undefined) throw new Error('Empty Soroban RPC result');
  return json.result;
}

/**
 * Retries a transient transport/server failure with exponential backoff
 * and full jitter (issue #142) before giving up with a typed
 * RpcUnavailableError/RpcTimeoutError. A non-transient failure (a JSON-RPC
 * error, a malformed request) is never retried and passes through
 * unmodified — retrying it would just fail again for the same reason.
 */
export async function callRpc<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RPC_ATTEMPTS; attempt++) {
    try {
      return await callRpcOnce<T>(method, params);
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === MAX_RPC_ATTEMPTS - 1) {
        break;
      }
      const exponential = Math.min(
        RETRY_BASE_DELAY_MS * 2 ** attempt,
        RETRY_MAX_DELAY_MS,
      );
      await sleep(Math.random() * exponential);
    }
  }

  if (!isRetryableRpcError(lastError)) {
    throw lastError;
  }
  const raw = lastError instanceof Error ? lastError.message : String(lastError);
  throw isTimeoutMessage(lastError)
    ? new RpcTimeoutError(raw)
    : new RpcUnavailableError(raw);
}

export interface LedgerInfo {
  sequence: number;
  closedAt: string;
  protocolVersion: number;
}

export function getLatestLedger(): Promise<LedgerInfo> {
  return callRpc<LedgerInfo>('getLatestLedger');
}

// --- Transaction submission & confirmation (issue #141) ---------------
//
// There is currently no defined boundary anywhere between "the app
// believes a payment happened" and "the blockchain has actually confirmed
// it" — `sendTransaction` only reports whether the RPC node *accepted the
// transaction for relay*, never whether it was actually included and
// applied. `getTransaction`/`waitForTransaction` close that gap by polling
// for the real terminal outcome.

export interface SendTransactionResult {
  status: 'PENDING' | 'DUPLICATE' | 'TRY_AGAIN_LATER' | 'ERROR';
  hash: string;
  errorResultXdr?: string;
}

/** Submits an already-signed transaction envelope (base64 XDR) for relay. Does NOT mean it was included — see `waitForTransaction`. */
export function sendTransaction(
  signedTransactionXdr: string,
): Promise<SendTransactionResult> {
  return callRpc<SendTransactionResult>('sendTransaction', [
    { transaction: signedTransactionXdr },
  ]);
}

export interface GetTransactionResult {
  status: 'NOT_FOUND' | 'SUCCESS' | 'FAILED';
  latestLedger?: number;
  resultXdr?: string;
}

export function getTransaction(hash: string): Promise<GetTransactionResult> {
  return callRpc<GetTransactionResult>('getTransaction', [{ hash }]);
}

/**
 * A submitted transaction was included in a ledger but did not succeed —
 * covers both an outright rejection and a contract call that reverted
 * after inclusion. Soroban surfaces both as a non-SUCCESS `getTransaction`
 * status (unlike chains where a reverted call can still be "successfully
 * included"), so no separate XDR inspection is needed to catch this case.
 */
export class TransactionFailedError extends Error {
  // Definitive and final (Soroban's single-host-function-invocation
  // atomicity — see contracts/vault_router/src/lib.rs's withdraw comment),
  // but the signed envelope that got here is now stale (its sequence
  // number is consumed either way), so retrying means a fresh intent.
  readonly retryClassification: RetryClassification = 'retryable-with-new-intent';
  constructor(readonly hash: string) {
    super(`Transaction ${hash} was included but failed on-chain`);
    this.name = 'TransactionFailedError';
  }
}

/**
 * Polling gave up before `getTransaction` ever reported SUCCESS or FAILED
 * — the hash stayed NOT_FOUND past the deadline. This can mean the
 * transaction is still propagating somewhere slow, or that it was quietly
 * dropped; either way the caller must stop waiting, and must not treat it
 * as a confirmed failure (nothing confirmed it failed, only that we gave
 * up watching).
 */
export class TransactionTimedOutError extends Error {
  // Ambiguous, not a confirmed failure — the caller must re-query chain
  // state by this hash before assuming anything, never resubmit blindly.
  readonly retryClassification: RetryClassification = 'retryable-with-new-intent';
  constructor(readonly hash: string) {
    super(`Timed out waiting for transaction ${hash} to confirm`);
    this.name = 'TransactionTimedOutError';
  }
}

export interface WaitForTransactionOptions {
  /** Fired with each observed lifecycle status as polling progresses. */
  onStatus?: (status: IntentStatus) => void;
  /** Delay before the first poll and the base for exponential backoff between polls. Default 1500ms. */
  pollIntervalMs?: number;
  /** Hard cap on total wait time before giving up with a TransactionTimedOutError. Default 60000ms. */
  timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_POLL_INTERVAL_MS = 5_000;
/**
 * Confirmation-depth policy (issue #141): Stellar/Soroban's consensus
 * (SCP) gives a ledger deterministic finality the moment it closes — there
 * is no probabilistic reorg window the way Nakamoto-consensus chains have,
 * so there is no separate "included but not yet safe" state to model. The
 * instant `getTransaction` reports SUCCESS, the result is final. This
 * timeout is generous past Soroban's typical propagation window purely to
 * stop polling forever — a legitimate submission resolves in a few
 * ledgers (a few seconds), well under this.
 */
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `getTransaction` for `hash` until it resolves to a terminal
 * on-chain outcome, driving `onStatus` through the canonical status
 * lifecycle (mirrors `TransactionPipeline.waitForTransaction` in the
 * TypeScript SDK — see sdks/typescript/src/transactions.ts). Resolves on
 * SUCCESS; rejects with `TransactionFailedError` on FAILED or
 * `TransactionTimedOutError` if the deadline passes while still NOT_FOUND.
 */
export async function waitForTransaction(
  hash: string,
  opts: WaitForTransactionOptions = {},
): Promise<void> {
  const baseIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  opts.onStatus?.('pending');

  for (let attempt = 0; ; attempt++) {
    const result = await getTransaction(hash);

    if (result.status === 'SUCCESS') {
      opts.onStatus?.('confirmed');
      return;
    }

    if (result.status === 'FAILED') {
      opts.onStatus?.('failed');
      throw new TransactionFailedError(hash);
    }

    // NOT_FOUND: keep polling until the deadline, then stop rather than
    // loop forever — never assume a bare NOT_FOUND is itself a failure.
    if (Date.now() >= deadline) {
      opts.onStatus?.('expired');
      throw new TransactionTimedOutError(hash);
    }

    const backoff = Math.min(
      baseIntervalMs * 2 ** attempt,
      MAX_POLL_INTERVAL_MS,
    );
    await sleep(backoff);
  }
}
