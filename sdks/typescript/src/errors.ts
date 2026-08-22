/**
 * How safe/appropriate it is to retry after a given error (issue #142).
 *
 * - 'retryable-safely': nothing was submitted/accepted on-chain, so
 *   retrying — even automatically — carries no risk of a duplicate
 *   operation. Covers pre-submission failures (contract-revert-in-
 *   simulation is the one exception, see 'not-retryable' below), wallet
 *   rejections, and RPC/network failures that never reached the network.
 * - 'retryable-with-new-intent': the outcome is ambiguous (we don't know
 *   whether the transaction landed) or the original attempt is now
 *   provably stale (e.g. a definitive on-chain revert already consumed its
 *   sequence number). The caller must check chain state and/or build a
 *   fresh intent (new simulate/build/sign) before retrying — never blindly
 *   resubmit the same attempt.
 * - 'not-retryable': retrying with the same input won't succeed (e.g. a
 *   BelowMinDeposit revert) or requires external state to change first
 *   (e.g. ProtocolPaused). Nothing stops the user from changing their
 *   input and trying again — that's a new action, not a "retry".
 */
export type RetryClassification =
  | 'retryable-safely'
  | 'retryable-with-new-intent'
  | 'not-retryable';

export abstract class YieldLadderError extends Error {
  protected constructor(
    message: string,
    readonly retryClassification: RetryClassification,
  ) {
    super(message);
    this.name = 'YieldLadderError';
  }
}

export class LockNotExpiredError extends YieldLadderError {
  constructor() {
    super('Lock period has not expired yet', 'not-retryable');
    this.name = 'LockNotExpiredError';
  }
}

export class BelowMinDepositError extends YieldLadderError {
  constructor() {
    super('Amount is below the minimum deposit', 'not-retryable');
    this.name = 'BelowMinDepositError';
  }
}

// The rest mirror contracts/vault_router/src/error.rs's VaultError and
// contracts/vault_l3(/l6/l12)/src/lib.rs's VaultError. VaultRouter validates
// InvalidTier/BelowMinDeposit/AssetNotAllowed/DepositCapExceeded/
// ProtocolPaused at the very top of every entrypoint, before ever forwarding
// to a tier vault — so a simulation error carrying one of those codes is
// always from the router itself.
//
// Code 4 is the one genuine cross-contract collision that matters today:
// VaultRouter's AssetNotAllowed=4 (raised on `deposit`) and VaultL3/L6/L12's
// NotYetMatured=4 (raised on `relock`) share a discriminant but mean
// different things. They're only reachable from different operations
// though (relock never runs router's asset check; deposit never reaches
// relock's maturity check), so `mapContractError` disambiguates by the
// method being simulated, not the code alone.
//
// Code 7 (VaultRouter's Unauthorized=7, VaultL3/L6/L12's
// AmountExceedsBalance=7) would be a similar collision, but VaultRouter's
// own Unauthorized variant is never actually raised anywhere in the
// contract today (auth is enforced via `require_auth()`, not this custom
// error) — verified against contracts/vault_router/src/lib.rs. So code 7
// unambiguously means AmountExceedsBalance in the current contracts. If
// VaultRouter ever starts raising Unauthorized via `panic_with_error`, this
// mapping needs the same method-based disambiguation code 4 already has.

export class InvalidTierError extends YieldLadderError {
  constructor() {
    super('Unknown or unsupported tier', 'not-retryable');
    this.name = 'InvalidTierError';
  }
}

export class AssetNotAllowedError extends YieldLadderError {
  constructor() {
    super('Asset is not on the deposit allowlist', 'not-retryable');
    this.name = 'AssetNotAllowedError';
  }
}

export class DepositCapExceededError extends YieldLadderError {
  constructor() {
    super("Deposit would exceed the tier vault's TVL cap", 'not-retryable');
    this.name = 'DepositCapExceededError';
  }
}

export class ProtocolPausedError extends YieldLadderError {
  constructor() {
    super('Protocol is currently paused', 'not-retryable');
    this.name = 'ProtocolPausedError';
  }
}

/** Raised by `relock` on a position that hasn't matured yet — see the code-4 note above. */
export class NotYetMaturedError extends YieldLadderError {
  constructor() {
    super('Position has not matured yet', 'not-retryable');
    this.name = 'NotYetMaturedError';
  }
}

/** Raised by `withdraw`/`earlyExit` when the requested amount exceeds the caller's balance. */
export class AmountExceedsBalanceError extends YieldLadderError {
  constructor() {
    super('Amount exceeds the available balance', 'not-retryable');
    this.name = 'AmountExceedsBalanceError';
  }
}

/**
 * A contract-level rejection whose numeric code didn't map to one of the
 * typed errors above — a real, specific contract rejection, just not one
 * this SDK version can name with certainty (e.g. a contract upgrade adds a
 * new error variant this SDK predates).
 */
export class VaultContractError extends YieldLadderError {
  constructor(
    readonly code: number,
    readonly rawError: string,
  ) {
    super(`Vault contract rejected the call (code ${code})`, 'not-retryable');
    this.name = 'VaultContractError';
  }
}

/** Simulation itself failed for a reason other than a parseable contract error. */
export class SimulationFailedError extends YieldLadderError {
  constructor(
    message: string,
    readonly rawError: string,
  ) {
    super(message, 'not-retryable');
    this.name = 'SimulationFailedError';
  }
}

/**
 * The transaction's time-bounds expired — most often because the user took
 * too long at their wallet's signing prompt. Distinct from a contract-level
 * rejection: nothing about the transaction itself was invalid, it just
 * arrived too late to be included. Nothing was accepted on-chain, so a
 * fresh attempt is unconditionally safe.
 */
export class TransactionExpiredError extends YieldLadderError {
  constructor() {
    super(
      'Transaction expired before it could be submitted — please try again',
      'retryable-safely',
    );
    this.name = 'TransactionExpiredError';
  }
}

/**
 * Submission failed with a definitive, synchronous rejection from the RPC
 * node (e.g. a bad sequence number) — the transaction was never broadcast,
 * so retrying is safe, though it needs a fresh build (new sequence/fee),
 * not a resubmission of the same signed envelope.
 */
export class SubmissionFailedError extends YieldLadderError {
  constructor(
    message: string,
    readonly rawResponse?: unknown,
  ) {
    super(message, 'retryable-safely');
    this.name = 'SubmissionFailedError';
  }
}

/**
 * A submitted transaction was included in a ledger but did not succeed —
 * covers both an outright tx-level rejection and a contract call that
 * reverted after inclusion (Soroban surfaces both as a non-SUCCESS
 * `getTransaction` status, unlike chains where a reverted call can still be
 * "successfully included"). Soroban's single-host-function-invocation
 * atomicity means this is a definitive, all-or-nothing outcome — never a
 * partially-applied one — but the signed envelope that got here is now
 * stale (its sequence number is consumed either way), so retrying means
 * building a fresh intent, not resubmitting it.
 */
export class TransactionFailedError extends YieldLadderError {
  constructor(readonly hash: string) {
    super(`Transaction ${hash} was included but failed on-chain`, 'retryable-with-new-intent');
    this.name = 'TransactionFailedError';
  }
}

/**
 * Polling gave up before `getTransaction` ever reported SUCCESS or FAILED —
 * the hash stayed NOT_FOUND past the poll deadline. This can mean the
 * transaction is still propagating somewhere slow, or that it was quietly
 * dropped; either way, the caller must stop waiting rather than poll
 * forever, and should treat this as "unknown," not "confirmed failure." A
 * caller must re-check chain state by this hash before deciding to retry —
 * never assume local retry-exhaustion alone proves the transaction failed.
 */
export class TransactionTimedOutError extends YieldLadderError {
  constructor(readonly hash: string) {
    super(`Timed out waiting for transaction ${hash} to confirm`, 'retryable-with-new-intent');
    this.name = 'TransactionTimedOutError';
  }
}

/**
 * The RPC endpoint could not be reached at all (DNS failure, connection
 * refused, offline) — distinct from a timeout, where a connection was
 * established but no response arrived in time. Raised only after the
 * pipeline's own retry-with-backoff (see transactions.ts) has already
 * exhausted its attempts.
 */
export class RpcUnavailableError extends YieldLadderError {
  constructor(readonly rawError: string) {
    super('Could not reach the Soroban RPC endpoint', 'retryable-safely');
    this.name = 'RpcUnavailableError';
  }
}

/** An RPC request was sent but no response arrived before the deadline. Raised only after retries are exhausted. */
export class RpcTimeoutError extends YieldLadderError {
  constructor(readonly rawError: string) {
    super('The Soroban RPC endpoint did not respond in time', 'retryable-safely');
    this.name = 'RpcTimeoutError';
  }
}

/**
 * The connected wallet declined to sign — a user action (clicked "Reject"),
 * not a network or contract failure. Trivially retryable: nothing was
 * built that can't be rebuilt, and the user can simply approve next time.
 */
export class WalletRejectedError extends YieldLadderError {
  constructor() {
    super('You declined the request in your wallet', 'retryable-safely');
    this.name = 'WalletRejectedError';
  }
}

/**
 * The wallet was disconnected (extension locked, session expired, tab
 * lost its connection) partway through signing. Distinct from a rejection:
 * the user didn't decline, the connection itself dropped.
 */
export class WalletDisconnectedError extends YieldLadderError {
  constructor() {
    super('Wallet disconnected before it could sign — please reconnect and try again', 'retryable-safely');
    this.name = 'WalletDisconnectedError';
  }
}

/**
 * The wallet's `signTransaction` rejected for a reason that's neither a
 * recognized decline nor a recognized disconnect (e.g. the wallet itself
 * errored internally). Nothing was ever submitted, so retrying is safe.
 */
export class WalletSigningFailedError extends YieldLadderError {
  constructor(readonly rawError: string) {
    super('Signing failed', 'retryable-safely');
    this.name = 'WalletSigningFailedError';
  }
}

/**
 * `sendTransaction` itself threw (a network/RPC-transport failure, not a
 * response the RPC returned) — genuinely ambiguous whether the transaction
 * reached the network. `hash` is the LOCALLY-computed hash of the signed
 * envelope (available even though nothing confirms it was ever received),
 * so a caller can poll `getTransaction(hash)` to resolve the ambiguity
 * before deciding whether to build and submit a fresh attempt.
 */
export class AmbiguousSubmissionError extends YieldLadderError {
  constructor(
    readonly hash: string | null,
    readonly rawError: string,
  ) {
    super(
      'Submission may or may not have reached the network — check status before retrying',
      'retryable-with-new-intent',
    );
    this.name = 'AmbiguousSubmissionError';
  }
}
