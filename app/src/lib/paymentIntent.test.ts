import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIntent,
  beginSubmission,
  markAwaitingSignature,
  markSubmitted,
  markConfirmed,
  markFailed,
  findActiveIntent,
  loadIntent,
  isTerminal,
  type StorageLike,
} from './paymentIntent';

function makeMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe('paymentIntent (issue #140)', () => {
  let storage: StorageLike;

  beforeEach(() => {
    storage = makeMemoryStorage();
  });

  it('generates distinct keys for two intents created independently, even with identical params', () => {
    const a = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const b = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);

    expect(a.key).not.toBe(b.key);
  });

  it('rapid double-invocation for the same intent: the second beginSubmission is refused', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);

    const first = beginSubmission(intent, storage);
    expect(first).not.toBeNull();
    expect(first!.status).toBe('building');

    // Simulate a double-click: the caller still holds the ORIGINAL idle
    // intent object (React state hasn't re-rendered yet) and re-invokes.
    const second = beginSubmission(intent, storage);
    expect(second).toBeNull();
  });

  it('a second click using the already-updated (building) intent is also refused', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const building = beginSubmission(intent, storage)!;

    const again = beginSubmission(building, storage);
    expect(again).toBeNull();
  });

  it('blocks a second tab racing the same logical operation with a DIFFERENT intent key', () => {
    const tabA = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const tabB = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    expect(tabA.key).not.toBe(tabB.key);

    const startedA = beginSubmission(tabA, storage);
    expect(startedA).not.toBeNull();

    // Tab B's own intent is still `idle`, but the operation lock is held by
    // tab A's (different) intent — must be refused.
    const startedB = beginSubmission(tabB, storage);
    expect(startedB).toBeNull();
  });

  it('does not conflate two genuinely separate deliberate deposits (sequential, not concurrent)', () => {
    const first = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const startedFirst = beginSubmission(first, storage)!;
    markConfirmed(startedFirst, storage);

    const second = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const startedSecond = beginSubmission(second, storage);

    expect(startedSecond).not.toBeNull();
    expect(startedSecond!.status).toBe('building');
  });

  it('releases the lock on failure so a resubmission is not blocked forever', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const building = beginSubmission(intent, storage)!;
    const awaiting = markAwaitingSignature(building, storage);
    const failed = markFailed(awaiting, 'User rejected the signing request', storage);

    expect(failed.status).toBe('failed');
    expect(isTerminal(failed.status)).toBe(true);

    // Retry: the SAME intent (still failed/idle-eligible) can re-enter building.
    const retried = beginSubmission(failed, storage);
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe('building');

    // A completely fresh intent for the same operation is also unblocked.
    const fresh = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    // ...but the retried intent above already re-acquired the lock, so this
    // fresh one is correctly refused until THAT one resolves.
    expect(beginSubmission(fresh, storage)).toBeNull();
  });

  it('releases the lock on success so a later fresh deposit is not blocked', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const building = beginSubmission(intent, storage)!;
    const submitted = markSubmitted(building, 'tx-hash-1', storage);
    expect(submitted.status).toBe('submitted');
    expect(submitted.txHash).toBe('tx-hash-1');

    markConfirmed(submitted, storage);

    const next = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    expect(beginSubmission(next, storage)).not.toBeNull();
  });

  it('findActiveIntent rehydrates a submitted-but-not-yet-terminal intent (reload mid-flight)', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const building = beginSubmission(intent, storage)!;
    const awaiting = markAwaitingSignature(building, storage);
    markSubmitted(awaiting, 'tx-hash-2', storage);

    // Simulate a page reload: nothing but storage survives.
    const rehydrated = findActiveIntent('deposit', 'GADDR', 'Flex', storage);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.key).toBe(intent.key);
    expect(rehydrated!.status).toBe('submitted');
    expect(rehydrated!.txHash).toBe('tx-hash-2');
  });

  it('findActiveIntent returns null once the intent has reached a terminal state', () => {
    const intent = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const building = beginSubmission(intent, storage)!;
    markConfirmed(building, storage);

    expect(findActiveIntent('deposit', 'GADDR', 'Flex', storage)).toBeNull();
  });

  it('findActiveIntent returns null when nothing has ever been started', () => {
    expect(findActiveIntent('deposit', 'GADDR', 'Flex', storage)).toBeNull();
  });

  it('different tiers for the same address do not share a lock', () => {
    const flex = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const l3 = createIntent('deposit', 'GADDR', 'L3', 'USDC', '50', storage);

    expect(beginSubmission(flex, storage)).not.toBeNull();
    expect(beginSubmission(l3, storage)).not.toBeNull();
  });

  it('different kinds (deposit vs earlyExit) for the same address/tier do not share a lock', () => {
    const deposit = createIntent('deposit', 'GADDR', 'Flex', 'USDC', '10', storage);
    const exit = createIntent('earlyExit', 'GADDR', 'Flex', 'USDC', '10', storage);

    expect(beginSubmission(deposit, storage)).not.toBeNull();
    expect(beginSubmission(exit, storage)).not.toBeNull();
  });

  it('persists intent state through loadIntent by key', () => {
    const intent = createIntent('withdraw', 'GADDR', 'L6', 'USDC', '100', storage);
    beginSubmission(intent, storage);

    const reloaded = loadIntent(intent.key, storage);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe('building');
  });
});
