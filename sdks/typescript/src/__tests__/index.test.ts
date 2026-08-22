import { randomBytes } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { YieldLadder } from '../index';
import {
  AmountExceedsBalanceError,
  AssetNotAllowedError,
  BelowMinDepositError,
  LockNotExpiredError,
  ProtocolPausedError,
  SubmissionFailedError,
  TransactionExpiredError,
  VaultContractError,
} from '../errors';
import type { YieldLadderOptions } from '../types';

const mockGetAccount = vi.fn();
const mockSimulateTransaction = vi.fn();
const mockSendTransaction = vi.fn();
const mockAssembleTransaction = vi.fn();

// Only SorobanRpc.Server (network I/O) and assembleTransaction are mocked;
// Address/Keypair/nativeToScVal/scValToNative/xdr encode-decode logic is
// the real implementation, so this suite exercises actual ScVal
// construction/parsing, not a fake of it.
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

const routerContractId = Address.contract(randomBytes(32)).toString();
const assetContractId = Address.contract(randomBytes(32)).toString();
const userKeypair = Keypair.random();

function makeOptions(overrides: Partial<YieldLadderOptions> = {}): YieldLadderOptions {
  return {
    network: 'testnet',
    publicKey: userKeypair.publicKey(),
    signer: { signTransaction: vi.fn(async (xdrString: string) => xdrString) },
    vaultRouterContractId: routerContractId,
    assetContractId,
    ...overrides,
  };
}

function fakeAccount(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '1',
    incrementSequenceNumber: () => undefined,
  };
}

function successSim(retval: xdr.ScVal) {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '100',
    cost: { cpuInsns: '0', memBytes: '0' },
    result: { auth: [], retval },
  };
}

function errorSim(error: string) {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error };
}

function stubHappyPathSubmit(hash: string) {
  mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
    build: () => rawTx,
  }));
  mockSendTransaction.mockResolvedValueOnce({ status: 'PENDING', hash });
}

function positionScVal(principal: bigint, shares: bigint, lockUntil: number) {
  return xdr.ScVal.scvMap(
    [
      ['principal', nativeToScVal(principal, { type: 'i128' })],
      ['shares', nativeToScVal(shares, { type: 'i128' })],
      ['lock_until', xdr.ScVal.scvU32(lockUntil)],
    ].map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key as string),
          val: val as xdr.ScVal,
        }),
    ),
  );
}

describe('YieldLadder', () => {
  let sdk: YieldLadder;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockImplementation(async (pk: string) => fakeAccount(pk));
    sdk = new YieldLadder(makeOptions());
  });

  describe('deposit', () => {
    it('throws BelowMinDepositError below the Flex minimum without ever calling the RPC', async () => {
      await expect(
        sdk.deposit({ tier: 'Flex', amount: '5' }),
      ).rejects.toBeInstanceOf(BelowMinDepositError);
      expect(mockGetAccount).not.toHaveBeenCalled();
    });

    it('throws BelowMinDepositError below the L12 minimum', async () => {
      await expect(
        sdk.deposit({ tier: 'L12', amount: '249' }),
      ).rejects.toBeInstanceOf(BelowMinDepositError);
    });

    it('submits a real transaction and returns the tx hash on success', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        successSim(xdr.ScVal.scvVoid()),
      );
      stubHappyPathSubmit('deposit-hash-1');

      const hash = await sdk.deposit({ tier: 'Flex', amount: '10' });

      expect(hash).toBe('deposit-hash-1');
      expect(mockGetAccount).toHaveBeenCalledWith(userKeypair.publicKey());
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('signs the assembled transaction via the configured Signer', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        successSim(xdr.ScVal.scvVoid()),
      );
      stubHappyPathSubmit('deposit-hash-2');
      const signer = { signTransaction: vi.fn(async (x: string) => x) };
      const signingSdk = new YieldLadder(makeOptions({ signer }));

      await signingSdk.deposit({ tier: 'Flex', amount: '10' });

      expect(signer.signTransaction).toHaveBeenCalledTimes(1);
      expect(signer.signTransaction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ accountToSign: userKeypair.publicKey() }),
      );
    });

    it('maps a simulated AssetNotAllowed rejection (code 4) to a typed error', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #4)'),
      );

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(AssetNotAllowedError);
    });

    it('maps a simulated ProtocolPaused rejection (code 6) to a typed error', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #6)'),
      );

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(ProtocolPausedError);
    });

    it('maps a simulated BelowMinDeposit rejection from the contract itself (code 2)', async () => {
      // The SDK's own pre-check passes (10 >= Flex minimum) but the
      // contract rejects anyway — still surfaced as the same typed error.
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #2)'),
      );

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(BelowMinDepositError);
    });

    it('maps a simulated AmountExceedsBalance rejection (code 7) to a typed error', async () => {
      // issue #142: code 7 used to fall back to the generic
      // VaultContractError — VaultRouter's own code-7 variant (Unauthorized)
      // is never actually raised anywhere in the contract, so this is
      // unambiguously VaultL3's AmountExceedsBalance.
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #7)'),
      );

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(AmountExceedsBalanceError);
    });

    it('falls back to a generic VaultContractError for a genuinely unmapped code', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        errorSim('HostError: Error(Contract, #99)'),
      );

      const error = await sdk
        .deposit({ tier: 'Flex', amount: '10' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VaultContractError);
      expect((error as VaultContractError).code).toBe(99);
    });

    it('throws TransactionExpiredError when submission reports txTooLate', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        successSim(xdr.ScVal.scvVoid()),
      );
      mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
        build: () => rawTx,
      }));
      mockSendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        hash: 'expired-hash',
        errorResult: {
          result: () => ({ switch: () => ({ name: 'txTooLate' }) }),
        },
      });

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(TransactionExpiredError);
    });

    it('throws SubmissionFailedError for a non-expiry submission rejection', async () => {
      mockSimulateTransaction.mockResolvedValueOnce(
        successSim(xdr.ScVal.scvVoid()),
      );
      mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
        build: () => rawTx,
      }));
      mockSendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        hash: 'bad-hash',
        errorResult: {
          result: () => ({ switch: () => ({ name: 'txFailed' }) }),
        },
      });

      await expect(
        sdk.deposit({ tier: 'Flex', amount: '10' }),
      ).rejects.toBeInstanceOf(SubmissionFailedError);
    });
  });

  describe('withdraw', () => {
    it('queries the current position, then withdraws exactly that principal', async () => {
      mockSimulateTransaction
        .mockResolvedValueOnce(successSim(positionScVal(500_0000000n, 525_0000000n, 0)))
        .mockResolvedValueOnce(successSim(xdr.ScVal.scvVoid()));
      stubHappyPathSubmit('withdraw-hash-1');

      const hash = await sdk.withdraw({ tier: 'L3' });

      expect(hash).toBe('withdraw-hash-1');
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });

    it('maps a simulated lock-not-expired rejection (code 3) to LockNotExpiredError', async () => {
      mockSimulateTransaction
        .mockResolvedValueOnce(successSim(positionScVal(500_0000000n, 525_0000000n, 999_999_999)))
        .mockResolvedValueOnce(errorSim('HostError: Error(Contract, #3)'));

      await expect(sdk.withdraw({ tier: 'L3' })).rejects.toBeInstanceOf(
        LockNotExpiredError,
      );
    });
  });

  describe('earlyExit', () => {
    it('simulates exactly once (no redundant double-simulate)', async () => {
      mockSimulateTransaction
        .mockResolvedValueOnce(successSim(positionScVal(500_0000000n, 525_0000000n, 999_999_999)))
        .mockResolvedValueOnce(successSim(xdr.ScVal.scvVoid()));
      stubHappyPathSubmit('early-exit-hash-1');

      const hash = await sdk.earlyExit({ tier: 'L6' });

      expect(hash).toBe('early-exit-hash-1');
      // One simulateTransaction call for the position query, one for the
      // early_exit call itself — never two for the same invocation.
      expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('position', () => {
    it('decodes a real Position struct from the simulated retval', async () => {
      mockSimulateTransaction
        .mockResolvedValueOnce(successSim(positionScVal(0n, 0n, 0)))
        .mockResolvedValueOnce(successSim(positionScVal(500_0000000n, 525_0000000n, 123_456)))
        .mockResolvedValueOnce(successSim(positionScVal(0n, 0n, 0)))
        .mockResolvedValueOnce(successSim(positionScVal(0n, 0n, 0)));

      const result = await sdk.position(userKeypair.publicKey());

      expect(result).toEqual({
        tier: 'L3',
        principal: '5000000000',
        shares: '5250000000',
        accruedYield: '0',
        lockUntil: 123_456,
      });
    });

    it('falls back to the first tier (Flex) when no position has a non-zero principal', async () => {
      mockSimulateTransaction.mockResolvedValue(successSim(positionScVal(0n, 0n, 0)));

      const result = await sdk.position(userKeypair.publicKey());

      expect(result.tier).toBe('Flex');
      expect(result.lockUntil).toBeNull();
    });
  });
});
