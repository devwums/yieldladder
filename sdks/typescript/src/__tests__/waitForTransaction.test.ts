import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { TransactionPipeline } from '../transactions';
import { TransactionFailedError, TransactionTimedOutError } from '../errors';
import type { PaymentStatus } from '../types';

const mockGetTransaction = vi.fn();

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: vi.fn().mockImplementation(() => ({
        getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
      })),
    },
  };
});

const userKeypair = Keypair.random();

function makePipeline(): TransactionPipeline {
  return new TransactionPipeline({
    rpcUrl: 'https://example.invalid',
    network: 'testnet',
    publicKey: userKeypair.publicKey(),
    signer: { signTransaction: vi.fn(async (xdrString: string) => xdrString) },
  });
}

describe('TransactionPipeline.waitForTransaction (issue #141)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves as soon as getTransaction reports SUCCESS', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' });
    const pipeline = makePipeline();
    const statuses: PaymentStatus[] = [];

    await pipeline.waitForTransaction('hash-1', {
      onStatus: (s) => statuses.push(s),
    });

    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetTransaction).toHaveBeenCalledWith('hash-1');
    expect(statuses).toEqual(['pending', 'confirmed']);
  });

  it('keeps polling through NOT_FOUND (still propagating) until it resolves to SUCCESS', async () => {
    mockGetTransaction
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'NOT_FOUND' })
      .mockResolvedValueOnce({ status: 'SUCCESS' });
    const pipeline = makePipeline();

    await pipeline.waitForTransaction('hash-2', { pollIntervalMs: 1 });

    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it('rejects with TransactionFailedError when the transaction was included but failed on-chain', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' });
    const pipeline = makePipeline();
    const statuses: PaymentStatus[] = [];

    await expect(
      pipeline.waitForTransaction('hash-3', {
        onStatus: (s) => statuses.push(s),
      }),
    ).rejects.toBeInstanceOf(TransactionFailedError);
    expect(statuses).toEqual(['pending', 'failed']);
  });

  it('does not mistake a contract-level revert for confirmation — FAILED never resolves', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' });
    const pipeline = makePipeline();

    const error = await pipeline
      .waitForTransaction('hash-4')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).hash).toBe('hash-4');
  });

  it('rejects with TransactionTimedOutError if it never leaves NOT_FOUND before the deadline', async () => {
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
    const pipeline = makePipeline();
    const statuses: PaymentStatus[] = [];

    await expect(
      pipeline.waitForTransaction('hash-5', {
        pollIntervalMs: 1,
        timeoutMs: 5,
        onStatus: (s) => statuses.push(s),
      }),
    ).rejects.toBeInstanceOf(TransactionTimedOutError);
    expect(statuses[0]).toBe('pending');
    expect(statuses[statuses.length - 1]).toBe('expired');
  });
});
