/**
 * How safe/appropriate it is to retry after a given payment-flow error
 * (issue #142). Mirrors the identical three-way taxonomy in the TypeScript
 * SDK (sdks/typescript/src/errors.ts) — kept in sync by convention, the
 * same way IntentStatus/PaymentStatus are (see paymentIntent.ts).
 *
 * - 'retryable-safely': nothing was submitted/accepted, so retrying (even
 *   automatically) carries no risk of a duplicate operation.
 * - 'retryable-with-new-intent': the outcome is ambiguous, or the original
 *   attempt is now stale — the caller must check on-chain state and/or
 *   mint a fresh intent before retrying, never blindly resubmit.
 * - 'not-retryable': retrying with the same input won't succeed, or
 *   requires external state to change first.
 */
export type RetryClassification =
  | 'retryable-safely'
  | 'retryable-with-new-intent'
  | 'not-retryable';
