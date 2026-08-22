import { randomBytes } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { TransactionPipeline } from '../transactions';
import type { Signer } from '../types';
import {
  AmbiguousSubmissionError,
  AmountExceedsBalanceError,
  AssetNotAllowedError,
  NotYetMaturedError,
  RpcTimeoutError,
  RpcUnavailableError,
  WalletDisconnectedError,
  WalletRejectedError,
  WalletSigningFailedError,
} from '../errors';

const mockGetAccount = vi.fn();
const mockSimulateTransaction = vi.fn();
const mockSendTransaction = vi.fn();
const mockAssembleTransaction = vi.fn();

// Same mocking approach as index.test.ts: only network I/O and
// assembleTransaction are faked, everything else (Address, ScVal encoding,
// Transaction parsing) is the real @stellar/stellar-sdk implementation.
vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: vi.fn().mockImplementation(() => ({
        getAccount: (...args: unknown[]) => mockGetAccount(...args),
        simulateTransaction: (...args: unknown[]) =>
          mockSimulateTransaction(...args),
        sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
      })),
      assembleTransaction: (...args: unknown[]) =>
        mockAssembleTransaction(...args),
    },
  };
});

const contractId = Address.contract(randomBytes(32)).toString();
const userKeypair = Keypair.random();

function fakeAccount(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '1',
    incrementSequenceNumber: () => undefined,
  };
}

function successSim() {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

function errorSim(error: string) {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error };
}

function makeSigner(impl: Signer['signTransaction'] = async (x) => x) {
  return { signTransaction: vi.fn(impl) };
}
type MockSigner = ReturnType<typeof makeSigner>;

function makePipeline(signer: MockSigner) {
  return new TransactionPipeline({
    rpcUrl: 'https://rpc.example',
    network: 'testnet',
    publicKey: userKeypair.publicKey(),
    signer,
  });
}

describe('TransactionPipeline', () => {
  let signer: MockSigner;
  let pipeline: TransactionPipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockImplementation(async (pk: string) => fakeAccount(pk));
    mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
      build: () => rawTx,
    }));
    signer = makeSigner();
    pipeline = makePipeline(signer);
  });

  describe('contract error mapping (issue #142)', () => {
    it('maps code 4 to AssetNotAllowedError for a deposit call', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #4)'),
      );

      await expect(
        pipeline.invoke({ contractId, method: 'deposit', args: [] }),
      ).rejects.toBeInstanceOf(AssetNotAllowedError);
    });

    it('maps the SAME code 4 to NotYetMaturedError for a relock call', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #4)'),
      );

      await expect(
        pipeline.invoke({ contractId, method: 'relock', args: [] }),
      ).rejects.toBeInstanceOf(NotYetMaturedError);
    });

    it('maps code 7 to AmountExceedsBalanceError', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #7)'),
      );

      await expect(
        pipeline.invoke({ contractId, method: 'withdraw', args: [] }),
      ).rejects.toBeInstanceOf(AmountExceedsBalanceError);
    });
  });

  describe('wallet-level signing failures', () => {
    it('classifies a rejected signature as WalletRejectedError', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(successSim());
      signer.signTransaction.mockRejectedValueOnce(
        new Error('User declined access'),
      );

      const error = await pipeline
        .invoke({ contractId, method: 'deposit', args: [] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WalletRejectedError);
      expect((error as WalletRejectedError).retryClassification).toBe(
        'retryable-safely',
      );
    });

    it('classifies a dropped wallet connection as WalletDisconnectedError', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(successSim());
      signer.signTransaction.mockRejectedValueOnce(
        new Error('Wallet is not connected'),
      );

      await expect(
        pipeline.invoke({ contractId, method: 'deposit', args: [] }),
      ).rejects.toBeInstanceOf(WalletDisconnectedError);
    });

    it('falls back to WalletSigningFailedError for an unrecognized signer error', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(successSim());
      signer.signTransaction.mockRejectedValueOnce(
        new Error('something internal broke'),
      );

      await expect(
        pipeline.invoke({ contractId, method: 'deposit', args: [] }),
      ).rejects.toBeInstanceOf(WalletSigningFailedError);
    });
  });

  describe('ambiguous submission failures', () => {
    it('throws AmbiguousSubmissionError with a locally-computed hash when sendTransaction itself throws', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(successSim());
      mockSendTransaction.mockRejectedValueOnce(new TypeError('fetch failed'));

      const error = await pipeline
        .invoke({ contractId, method: 'deposit', args: [] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AmbiguousSubmissionError);
      const ambiguous = error as AmbiguousSubmissionError;
      expect(ambiguous.retryClassification).toBe('retryable-with-new-intent');
      expect(typeof ambiguous.hash).toBe('string');
      expect(ambiguous.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('RPC transport retry (issue #142)', () => {
    it('retries a transient getAccount failure and succeeds without surfacing an error', async () => {
      mockGetAccount
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockImplementationOnce(async (pk: string) => fakeAccount(pk));
      mockSimulateTransaction.mockResolvedValueOnce(successSim());
      mockSendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'retried-hash',
      });

      const hash = await pipeline.invoke({
        contractId,
        method: 'deposit',
        args: [],
      });

      expect(hash).toBe('retried-hash');
      expect(mockGetAccount).toHaveBeenCalledTimes(2);
    });

    it('surfaces RpcUnavailableError once retries are exhausted on a persistent network failure', async () => {
      mockGetAccount.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        pipeline.invoke({ contractId, method: 'deposit', args: [] }),
      ).rejects.toBeInstanceOf(RpcUnavailableError);
      // maxAttempts is 3 by default for the RPC transport retry.
      expect(mockGetAccount).toHaveBeenCalledTimes(3);
    });

    it('surfaces RpcTimeoutError (not RpcUnavailableError) for a timeout-shaped failure', async () => {
      mockGetAccount.mockRejectedValue(new Error('request timed out'));

      await expect(
        pipeline.invoke({ contractId, method: 'deposit', args: [] }),
      ).rejects.toBeInstanceOf(RpcTimeoutError);
    });

    it('does not retry and does not relabel a non-network getAccount failure', async () => {
      const notFound = new Error('Account not found');
      mockGetAccount.mockRejectedValueOnce(notFound);

      const error = await pipeline
        .invoke({ contractId, method: 'deposit', args: [] })
        .catch((e: unknown) => e);

      expect(error).toBe(notFound);
      expect(mockGetAccount).toHaveBeenCalledTimes(1);
    });
  });
});
