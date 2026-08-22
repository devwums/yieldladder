import { randomBytes } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { YieldLadder } from '../index';
import type { YieldLadderOptions } from '../types';

const mockGetAccount = vi.fn();
const mockSimulateTransaction = vi.fn();
const mockSendTransaction = vi.fn();
const mockAssembleTransaction = vi.fn();

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

/** Resolves sendTransaction only once `resolve()` is called — lets a test
 * hold a "submission" open long enough to fire a second, racing call. */
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

function deferredSend() {
  let resolve!: (value: { status: string; hash: string }) => void;
  const promise = new Promise<{ status: string; hash: string }>((r) => {
    resolve = r;
  });
  mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
    build: () => rawTx,
  }));
  mockSendTransaction.mockReturnValueOnce(promise);
  return { resolve };
}

describe('idempotency guard (issue #140)', () => {
  let sdk: YieldLadder;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockImplementation(async (pk: string) => fakeAccount(pk));
    mockSimulateTransaction.mockResolvedValue(successSim(xdr.ScVal.scvVoid()));
    sdk = new YieldLadder(makeOptions());
  });

  it('rapid double-invocation of deposit for the same intent results in exactly one submitted transaction', async () => {
    const deferred = deferredSend();

    const first = sdk.deposit({ tier: 'Flex', amount: '10' });
    const second = sdk.deposit({ tier: 'Flex', amount: '10' });

    deferred.resolve({ status: 'PENDING', hash: 'only-hash' });
    const [hash1, hash2] = await Promise.all([first, second]);

    expect(hash1).toBe('only-hash');
    expect(hash2).toBe('only-hash');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('rapid double-invocation of withdraw for the same intent results in exactly one submitted transaction', async () => {
    mockSimulateTransaction.mockResolvedValue(
      successSim(positionScVal(5_000_000_000n, 5_000_000_000n, 0)),
    );
    const deferred = deferredSend();

    const first = sdk.withdraw({ tier: 'L3' });
    const second = sdk.withdraw({ tier: 'L3' });

    deferred.resolve({ status: 'PENDING', hash: 'withdraw-only-hash' });
    const [hash1, hash2] = await Promise.all([first, second]);

    expect(hash1).toBe('withdraw-only-hash');
    expect(hash2).toBe('withdraw-only-hash');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not dedup two calls with an explicitly different idempotencyKey', async () => {
    mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
      build: () => rawTx,
    }));
    mockSendTransaction
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'hash-a' })
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'hash-b' });

    const hashA = await sdk.deposit({ tier: 'Flex', amount: '10', idempotencyKey: 'intent-a' });
    const hashB = await sdk.deposit({ tier: 'Flex', amount: '10', idempotencyKey: 'intent-b' });

    expect(hashA).toBe('hash-a');
    expect(hashB).toBe('hash-b');
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('allows a later call with the same default key once the first has settled', async () => {
    mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
      build: () => rawTx,
    }));
    mockSendTransaction
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'first-hash' })
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'second-hash' });

    const first = await sdk.deposit({ tier: 'Flex', amount: '10' });
    const second = await sdk.deposit({ tier: 'Flex', amount: '10' });

    expect(first).toBe('first-hash');
    expect(second).toBe('second-hash');
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('releases the in-flight key on failure, so an immediate retry with the same key is not blocked forever', async () => {
    mockAssembleTransaction.mockImplementation((rawTx: unknown) => ({
      build: () => rawTx,
    }));
    mockSendTransaction
      .mockResolvedValueOnce({ status: 'ERROR', hash: 'bad-hash', errorResult: { result: () => ({ switch: () => ({ name: 'txFailed' }) }) } })
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'retry-hash' });

    await expect(sdk.deposit({ tier: 'Flex', amount: '10' })).rejects.toThrow();
    const retried = await sdk.deposit({ tier: 'Flex', amount: '10' });

    expect(retried).toBe('retry-hash');
    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  });

  it('deduplicates two concurrent calls with the same explicit idempotencyKey even across different tiers/amounts', async () => {
    const deferred = deferredSend();

    const first = sdk.deposit({ tier: 'Flex', amount: '10', idempotencyKey: 'shared-key' });
    const second = sdk.deposit({ tier: 'L3', amount: '50', idempotencyKey: 'shared-key' });

    deferred.resolve({ status: 'PENDING', hash: 'shared-hash' });
    const [hash1, hash2] = await Promise.all([first, second]);

    expect(hash1).toBe('shared-hash');
    expect(hash2).toBe('shared-hash');
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });
});
