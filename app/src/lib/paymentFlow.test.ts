import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyPaymentError,
  requestWalletSignature,
  runPaymentSubmission,
} from './paymentFlow';
import {
  RpcTimeoutError,
  RpcUnavailableError,
  TransactionFailedError,
  TransactionTimedOutError,
} from '../services/rpc';
import {
  WalletDisconnectedError,
  WalletRejectedError,
  WalletUnavailableError,
} from './wallet/errors';
import { createIntent, markAwaitingSignature, beginSubmission, type StorageLike } from './paymentIntent';

describe('classifyPaymentError (issue #142)', () => {
  it('classifies a wallet rejection as retryable-safely with the wallet message', () => {
    const result = classifyPaymentError(new WalletRejectedError());
    expect(result.retryClassification).toBe('retryable-safely');
    expect(result.message).toMatch(/declined/i);
  });

  it('classifies a dropped wallet connection as retryable-safely', () => {
    const result = classifyPaymentError(new WalletDisconnectedError());
    expect(result.retryClassification).toBe('retryable-safely');
    expect(result.message).toMatch(/disconnect/i);
  });

  it('classifies a missing wallet extension as retryable-safely', () => {
    const result = classifyPaymentError(new WalletUnavailableError('Freighter'));
    expect(result.retryClassification).toBe('retryable-safely');
    expect(result.message).toMatch(/freighter/i);
  });

  it('classifies an unreachable RPC endpoint as retryable-safely', () => {
    const result = classifyPaymentError(new RpcUnavailableError('fetch failed'));
    expect(result.retryClassification).toBe('retryable-safely');
    expect(result.message).toMatch(/reach/i);
  });

  it('classifies an RPC timeout as retryable-safely', () => {
    const result = classifyPaymentError(new RpcTimeoutError('timed out'));
    expect(result.retryClassification).toBe('retryable-safely');
    expect(result.message).toMatch(/respond/i);
  });

  it('classifies a confirmed on-chain failure as retryable-with-new-intent', () => {
    const result = classifyPaymentError(new TransactionFailedError('abc123'));
    expect(result.retryClassification).toBe('retryable-with-new-intent');
    expect(result.message).toMatch(/abc123/);
  });

  it('classifies an ambiguous confirmation timeout as retryable-with-new-intent', () => {
    const result = classifyPaymentError(new TransactionTimedOutError('abc123'));
    expect(result.retryClassification).toBe('retryable-with-new-intent');
  });

  it('falls back to a generic message and retryable-safely for an unrecognized Error', () => {
    const result = classifyPaymentError(new Error('something unexpected'));
    expect(result.message).toBe('something unexpected');
    expect(result.retryClassification).toBe('retryable-safely');
  });

  it('falls back gracefully for a non-Error throw', () => {
    const result = classifyPaymentError('a string, not an Error');
    expect(result.message).toBe('Transaction failed');
    expect(result.retryClassification).toBe('retryable-safely');
  });
});

describe('requestWalletSignature', () => {
  it('resolves (placeholder) so callers can await it like a real signing step', async () => {
    await expect(requestWalletSignature()).resolves.toBeUndefined();
  });
});

function makeMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

function makeAwaitingIntent(storage: StorageLike) {
  const intent = createIntent('deposit', 'GADDR', 'flex', 'USDC', '10', storage);
  return markAwaitingSignature(intent, storage);
}

describe('runPaymentSubmission (issue #142 — real injected failures)', () => {
  let storage: StorageLike;

  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  it('reaches the confirmed state on the happy path', async () => {
    const awaiting = makeAwaitingIntent(storage);

    const result = await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockResolvedValue('tx-hash-1'),
      waitForTransaction: vi.fn().mockResolvedValue(undefined),
      storage,
    });

    expect(result.status).toBe('confirmed');
    expect(result.intent.txHash).toBe('tx-hash-1');
    expect(result.message).toBeNull();
  });

  it('reaches the failed state with a wallet-specific message when the wallet rejects signing', async () => {
    const awaiting = makeAwaitingIntent(storage);

    const result = await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockRejectedValue(new WalletRejectedError()),
      submit: vi.fn(),
      waitForTransaction: vi.fn(),
      storage,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/declined/i);
    expect(result.intent.error).toMatch(/declined/i);
    // The signing step never resolved, so submission must never be attempted.
    expect(result.intent.txHash).toBeNull();
  });

  it('reaches the failed state with a network-specific message when submission cannot reach the RPC', async () => {
    const awaiting = makeAwaitingIntent(storage);

    const result = await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockRejectedValue(new RpcUnavailableError('fetch failed')),
      waitForTransaction: vi.fn(),
      storage,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/reach/i);
  });

  it('reaches the failed state when the transaction is included but reverts on-chain', async () => {
    const awaiting = makeAwaitingIntent(storage);

    const result = await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockResolvedValue('tx-hash-2'),
      waitForTransaction: vi
        .fn()
        .mockRejectedValue(new TransactionFailedError('tx-hash-2')),
      storage,
    });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/tx-hash-2/);
  });

  it('reaches the distinct expired state (not failed) when confirmation times out ambiguously', async () => {
    const awaiting = makeAwaitingIntent(storage);

    const result = await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockResolvedValue(undefined),
      submit: vi.fn().mockResolvedValue('tx-hash-3'),
      waitForTransaction: vi
        .fn()
        .mockRejectedValue(new TransactionTimedOutError('tx-hash-3')),
      storage,
    });

    expect(result.status).toBe('expired');
    expect(result.intent.status).toBe('expired');
  });

  it('releases the operation lock on failure so a retry is not blocked', async () => {
    const awaiting = makeAwaitingIntent(storage);

    await runPaymentSubmission(awaiting, {
      requestWalletSignature: vi.fn().mockRejectedValue(new WalletRejectedError()),
      submit: vi.fn(),
      waitForTransaction: vi.fn(),
      storage,
    });

    const retryIntent = createIntent('deposit', 'GADDR', 'flex', 'USDC', '10', storage);
    // beginSubmission would refuse if the previous attempt's lock were still held.
    expect(beginSubmission(retryIntent, storage)).not.toBeNull();
  });
});
