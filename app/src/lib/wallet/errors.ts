import type { RetryClassification } from '../retryClassification';

/**
 * The connected wallet declined to sign — a user action, not a network or
 * contract failure. Trivially retryable: nothing was built that can't be
 * rebuilt, the user can simply approve next time (issue #142).
 */
export class WalletRejectedError extends Error {
  readonly retryClassification: RetryClassification = 'retryable-safely';
  constructor() {
    super('You declined the request in your wallet.');
    this.name = 'WalletRejectedError';
  }
}

/**
 * The wallet dropped its connection partway through signing (extension
 * locked, session expired) — distinct from a rejection: the user didn't
 * decline, the connection itself was lost.
 */
export class WalletDisconnectedError extends Error {
  readonly retryClassification: RetryClassification = 'retryable-safely';
  constructor() {
    super('Wallet disconnected before it could sign. Reconnect and try again.');
    this.name = 'WalletDisconnectedError';
  }
}

/** No supported wallet extension was detected in the browser. */
export class WalletUnavailableError extends Error {
  readonly retryClassification: RetryClassification = 'retryable-safely';
  constructor(provider = 'wallet') {
    super(`No ${provider} extension detected. Install it and reconnect.`);
    this.name = 'WalletUnavailableError';
  }
}
