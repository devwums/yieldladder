// Shared payment-flow helpers used by both app/src/app/deposit/page.tsx and
// app/src/components/EarlyExitModal.tsx (issue #142): the error taxonomy/
// classification, the submit -> sign -> wait orchestration, and the
// (still-placeholder, see requestWalletSignature's doc) wallet-signing
// step — "give every payment operation a complete, typed failure taxonomy
// and well-defined retry/recovery behavior."

import {
  RpcTimeoutError,
  RpcUnavailableError,
  TransactionFailedError,
  TransactionTimedOutError,
  waitForTransaction,
} from '../services/rpc';
import {
  WalletDisconnectedError,
  WalletRejectedError,
  WalletUnavailableError,
} from './wallet/errors';
import type { RetryClassification } from './retryClassification';
import {
  markConfirmed,
  markExpired,
  markFailed,
  markPending,
  markSubmitted,
  type PaymentIntent,
  type StorageLike,
} from './paymentIntent';

export interface ClassifiedPaymentError {
  message: string;
  retryClassification: RetryClassification;
}

/**
 * Maps any error a payment submission can throw to a user-facing message
 * and a retry classification, so the UI branches on one typed decision
 * instead of ad hoc `instanceof`/string checks scattered per component.
 */
export function classifyPaymentError(error: unknown): ClassifiedPaymentError {
  if (
    error instanceof WalletRejectedError ||
    error instanceof WalletDisconnectedError ||
    error instanceof WalletUnavailableError ||
    error instanceof RpcUnavailableError ||
    error instanceof RpcTimeoutError ||
    error instanceof TransactionFailedError ||
    error instanceof TransactionTimedOutError
  ) {
    return {
      message: error.message,
      retryClassification: error.retryClassification,
    };
  }

  return {
    message: error instanceof Error ? error.message : 'Transaction failed',
    // Unknown shape — safest default is to let the user try again rather
    // than silently blocking retry on an error we don't recognize.
    retryClassification: 'retryable-safely',
  };
}

/**
 * TODO(#141 follow-up, same as placeholderSubmissionHash in
 * app/src/app/deposit/page.tsx): stands in for asking the connected wallet
 * (via sdks/typescript's `Signer` interface) to sign the built transaction,
 * until the app depends on the SDK directly — see that file's comment for
 * why that wiring is deferred. A real implementation can throw
 * WalletRejectedError/WalletDisconnectedError/WalletUnavailableError; this
 * placeholder never does, but is a distinct, separately-mockable function
 * specifically so tests can inject those failures through the real
 * call site and prove the classifier + UI react correctly (issue #142
 * acceptance criteria: failure states reachable via real, injected
 * failures, not just hardcoded/manual triggers).
 */
export async function requestWalletSignature(): Promise<void> {
  // No-op placeholder — nothing to await yet.
}

export interface PaymentSubmissionDeps {
  requestWalletSignature: () => Promise<void>;
  /** Submits the payment and resolves with the transaction hash. */
  submit: (idempotencyKey: string) => Promise<string>;
  waitForTransaction: typeof waitForTransaction;
  storage?: StorageLike;
}

export const defaultPaymentSubmissionDeps: Pick<
  PaymentSubmissionDeps,
  'requestWalletSignature' | 'waitForTransaction'
> = {
  requestWalletSignature,
  waitForTransaction,
};

export interface PaymentSubmissionResult {
  intent: PaymentIntent;
  status: 'confirmed' | 'failed' | 'expired';
  message: string | null;
}

/**
 * Runs one payment attempt — deposit, withdraw, or early-exit; the
 * orchestration is identical for all three — from `awaiting` (an intent
 * already transitioned to `awaiting_signature`) through to a terminal
 * outcome, persisting each transition via paymentIntent.ts exactly as the
 * two components' previous separate inline versions did.
 *
 * `deps` is injected so tests can supply a signer/submit/wait that throws a
 * specific, real error and assert the resulting classification — see
 * paymentFlow.test.ts. This is what makes the deposit and early-exit
 * failure UI states reachable via real, injected failures rather than only
 * a hardcoded/manual trigger (issue #142 acceptance criteria).
 */
export async function runPaymentSubmission(
  awaiting: PaymentIntent,
  deps: PaymentSubmissionDeps,
  timeoutMs = 20_000,
): Promise<PaymentSubmissionResult> {
  try {
    await deps.requestWalletSignature();

    const txHash = await deps.submit(awaiting.key);
    const submitted = markSubmitted(awaiting, txHash, deps.storage);
    const pending = markPending(submitted, deps.storage);

    await deps.waitForTransaction(txHash, { timeoutMs });

    const confirmed = markConfirmed(pending, deps.storage);
    return { intent: confirmed, status: 'confirmed', message: null };
  } catch (error) {
    if (error instanceof TransactionTimedOutError) {
      // Friendlier than the raw classified message ("Timed out waiting for
      // transaction <hash> to confirm") — this is the ambiguous, ongoing-
      // uncertainty case (see TransactionTimedOutError's own doc comment),
      // worth explaining rather than just restating the hash.
      const message =
        'Could not confirm this transaction in time. It may still complete — check back before retrying.';
      const expired = markExpired(awaiting, message, deps.storage);
      return { intent: expired, status: 'expired', message };
    }

    const classified = classifyPaymentError(error);
    const failed = markFailed(awaiting, classified.message, deps.storage);
    return { intent: failed, status: 'failed', message: classified.message };
  }
}
