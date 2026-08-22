export class YieldLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YieldLadderError';
  }
}

export class LockNotExpiredError extends YieldLadderError {
  constructor() { super('Lock period has not expired yet'); this.name = 'LockNotExpiredError'; }
}

export class BelowMinDepositError extends YieldLadderError {
  constructor() { super('Amount is below the minimum deposit'); this.name = 'BelowMinDepositError'; }
}

// The rest mirror contracts/vault_router/src/error.rs's VaultError. Codes 2
// (BelowMinDeposit), 4 (AssetNotAllowed), and 6 (ProtocolPaused) are checked
// at the very top of every VaultRouter entrypoint before it ever forwards to
// a tier vault, so a simulation error carrying one of these codes is always
// unambiguously from the router itself — never from the tier vault's own
// (differently-numbered) error enum.

export class InvalidTierError extends YieldLadderError {
  constructor() { super('Unknown or unsupported tier'); this.name = 'InvalidTierError'; }
}

export class AssetNotAllowedError extends YieldLadderError {
  constructor() { super('Asset is not on the deposit allowlist'); this.name = 'AssetNotAllowedError'; }
}

export class DepositCapExceededError extends YieldLadderError {
  constructor() { super('Deposit would exceed the tier vault\'s TVL cap'); this.name = 'DepositCapExceededError'; }
}

export class ProtocolPausedError extends YieldLadderError {
  constructor() { super('Protocol is currently paused'); this.name = 'ProtocolPausedError'; }
}

/**
 * A contract-level rejection whose numeric code didn't map to one of the
 * typed errors above — most commonly code 7, which is genuinely ambiguous
 * between VaultRouter's own (rarely-raised) Unauthorized and a tier vault's
 * AmountExceedsBalance, since the two contracts' error enums don't share a
 * numbering scheme for every code. Still a real, specific contract
 * rejection — just not one this SDK can name with certainty.
 */
export class VaultContractError extends YieldLadderError {
  constructor(
    readonly code: number,
    readonly rawError: string,
  ) {
    super(`Vault contract rejected the call (code ${code})`);
    this.name = 'VaultContractError';
  }
}

/** Simulation itself failed for a reason other than a parseable contract error. */
export class SimulationFailedError extends YieldLadderError {
  constructor(
    message: string,
    readonly rawError: string,
  ) {
    super(message);
    this.name = 'SimulationFailedError';
  }
}

/**
 * The transaction's time-bounds expired — most often because the user took
 * too long at their wallet's signing prompt. Distinct from a contract-level
 * rejection: nothing about the transaction itself was invalid, it just
 * arrived too late to be included.
 */
export class TransactionExpiredError extends YieldLadderError {
  constructor() {
    super('Transaction expired before it could be submitted — please try again');
    this.name = 'TransactionExpiredError';
  }
}

/** Submission failed for a reason other than expiration or a mapped contract error. */
export class SubmissionFailedError extends YieldLadderError {
  constructor(
    message: string,
    readonly rawResponse?: unknown,
  ) {
    super(message);
    this.name = 'SubmissionFailedError';
  }
}

/**
 * A submitted transaction was included in a ledger but did not succeed —
 * covers both an outright tx-level rejection and a contract call that
 * reverted after inclusion (Soroban surfaces both as a non-SUCCESS
 * `getTransaction` status, unlike chains where a reverted call can still be
 * "successfully included").
 */
export class TransactionFailedError extends YieldLadderError {
  constructor(readonly hash: string) {
    super(`Transaction ${hash} was included but failed on-chain`);
    this.name = 'TransactionFailedError';
  }
}

/**
 * Polling gave up before `getTransaction` ever reported SUCCESS or FAILED —
 * the hash stayed NOT_FOUND past the poll deadline. This can mean the
 * transaction is still propagating somewhere slow, or that it was quietly
 * dropped; either way, the caller must stop waiting rather than poll
 * forever, and should treat this as "unknown," not "confirmed failure."
 */
export class TransactionTimedOutError extends YieldLadderError {
  constructor(readonly hash: string) {
    super(`Timed out waiting for transaction ${hash} to confirm`);
    this.name = 'TransactionTimedOutError';
  }
}
