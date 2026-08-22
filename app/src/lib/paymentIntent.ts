// Application-level idempotency guard for user-initiated payment actions
// (deposit / withdraw / early-exit) — issue #140. Shared by
// app/src/app/deposit/page.tsx and app/src/components/EarlyExitModal.tsx.
//
// Two records are persisted per logical operation:
//  - an "intent" (keyed by kind+address+tier+asset+amount+nonce) tracking
//    this specific attempt's state machine: idle -> building ->
//    awaiting_signature -> submitted -> pending -> confirmed | failed | expired.
//    (`submitted` means a tx hash exists; `pending` means the confirmation
//    poller (issue #141) is actively watching that hash for inclusion.)
//  - an "operation lock" (keyed by kind+address+tier, NO nonce) pointing at
//    whichever intent currently holds the right to submit. This is what
//    stops two browser tabs racing the same deposit even though each tab
//    generates its own nonce-suffixed intent key independently.
//
// Deliberately backed by localStorage rather than sessionStorage (unlike
// wallet/session.ts's session, which is intentionally per-tab): a reload
// AND a second tab both need to see the same lock, and localStorage is the
// only same-origin storage both share.

export type IntentKind = 'deposit' | 'withdraw' | 'earlyExit';

/**
 * Mirrored 1:1 by `PaymentStatus` in sdks/typescript/src/types.ts (issue
 * #141). The app and SDK are independently-versioned packages with
 * separate pnpm-lock.yaml files (no shared workspace), so they can't share
 * a single imported type — keep the literal sets identical by convention:
 * if you add/rename a value here, update the SDK's copy too. `idle` and
 * `building` have no SDK-side counterpart (pre-submission, app-local UI
 * states); the SDK's `simulating` has no app-side counterpart (internal to
 * `TransactionPipeline.doInvoke`, never observed by the app).
 */
export type IntentStatus =
  | 'idle'
  | 'building'
  | 'awaiting_signature'
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'expired';

export interface PaymentIntent {
  key: string;
  kind: IntentKind;
  address: string;
  tier: string;
  asset: string;
  amount: string;
  status: IntentStatus;
  txHash: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Lock {
  intentKey: string;
}

const INTENT_PREFIX = 'yl:intent:';
const LOCK_PREFIX = 'yl:intent-lock:';

// In-memory fallback so this module works during SSR and in tests without
// a real browser localStorage. This never persists across an actual page
// reload — but that gap only matters in a real browser tab, where
// localStorage exists and is used instead.
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

const memoryFallback = makeMemoryStorage();

function defaultStorage(): StorageLike {
  if (typeof window === 'undefined') return memoryFallback;
  try {
    return window.localStorage;
  } catch {
    return memoryFallback;
  }
}

function intentStorageKey(key: string): string {
  return `${INTENT_PREFIX}${key}`;
}

function lockStorageKey(kind: IntentKind, address: string, tier: string): string {
  return `${LOCK_PREFIX}${kind}:${address}:${tier}`;
}

function generateNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Every field except the nonce is deterministic for a given logical
 * operation. The nonce is what distinguishes two deliberate repeat actions
 * (same params, different intent, e.g. two separate deposits of the same
 * amount minutes apart) from an accidental resubmission of the SAME intent
 * (double-clicking reuses the already-generated key, not a new one).
 */
function buildIntentKey(
  kind: IntentKind,
  address: string,
  tier: string,
  asset: string,
  amount: string,
): string {
  return [kind, address, tier, asset, amount, generateNonce()].join(':');
}

export function isTerminal(status: IntentStatus): boolean {
  return status === 'confirmed' || status === 'failed' || status === 'expired';
}

export function createIntent(
  kind: IntentKind,
  address: string,
  tier: string,
  asset: string,
  amount: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  const now = Date.now();
  const intent: PaymentIntent = {
    key: buildIntentKey(kind, address, tier, asset, amount),
    kind,
    address,
    tier,
    asset,
    amount,
    status: 'idle',
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  saveIntent(intent, storage);
  return intent;
}

export function loadIntent(
  key: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent | null {
  const raw = storage.getItem(intentStorageKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PaymentIntent;
  } catch {
    return null;
  }
}

export function saveIntent(
  intent: PaymentIntent,
  storage: StorageLike = defaultStorage(),
): void {
  storage.setItem(intentStorageKey(intent.key), JSON.stringify(intent));
}

export function clearIntent(
  key: string,
  storage: StorageLike = defaultStorage(),
): void {
  storage.removeItem(intentStorageKey(key));
}

function loadLock(
  kind: IntentKind,
  address: string,
  tier: string,
  storage: StorageLike,
): Lock | null {
  const raw = storage.getItem(lockStorageKey(kind, address, tier));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Lock;
  } catch {
    return null;
  }
}

function saveLock(
  kind: IntentKind,
  address: string,
  tier: string,
  intentKey: string,
  storage: StorageLike,
): void {
  storage.setItem(lockStorageKey(kind, address, tier), JSON.stringify({ intentKey }));
}

function releaseLock(
  kind: IntentKind,
  address: string,
  tier: string,
  storage: StorageLike,
): void {
  storage.removeItem(lockStorageKey(kind, address, tier));
}

/**
 * Finds a persisted, not-yet-terminal intent for this logical operation —
 * used on page load / component mount to rehydrate instead of allowing a
 * fresh submission while a previous one is still `submitted` (or further
 * along) after a reload mid-flight.
 */
export function findActiveIntent(
  kind: IntentKind,
  address: string,
  tier: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent | null {
  const lock = loadLock(kind, address, tier, storage);
  if (!lock) return null;
  const intent = loadIntent(lock.intentKey, storage);
  if (!intent || isTerminal(intent.status)) return null;
  return intent;
}

/**
 * The re-entry guard. Refuses (returns null) when:
 *  - this exact intent has already left idle/failed/expired — a
 *    double-click on the same confirm button reuses the same
 *    already-generated intent, so its second call sees a status outside
 *    that retry-eligible set and is refused; or
 *  - a DIFFERENT intent for the same logical operation (kind/address/tier)
 *    currently holds the lock and hasn't reached a terminal state — this
 *    is what stops two browser tabs racing the same deposit even though
 *    each tab independently generated its own intent key.
 *
 * On success, returns the intent transitioned to `building` — the caller
 * must persist further transitions via markAwaitingSignature/markSubmitted/
 * markConfirmed/markFailed as the real submission progresses.
 */
export function beginSubmission(
  intent: PaymentIntent,
  storage: StorageLike = defaultStorage(),
): PaymentIntent | null {
  // Always re-check the PERSISTED status by key, never the possibly-stale
  // `intent.status` the caller happens to be holding — a double-click's
  // second handler invocation typically still closes over the exact same
  // (now-stale) React state object from before the first click's update,
  // so trusting `intent.status` here would defeat the guard entirely.
  const current = loadIntent(intent.key, storage) ?? intent;
  if (
    current.status !== 'idle' &&
    current.status !== 'failed' &&
    current.status !== 'expired'
  ) {
    return null;
  }

  const lock = loadLock(intent.kind, intent.address, intent.tier, storage);
  if (lock && lock.intentKey !== intent.key) {
    const holder = loadIntent(lock.intentKey, storage);
    if (holder && !isTerminal(holder.status)) {
      return null;
    }
  }

  const updated: PaymentIntent = {
    ...current,
    status: 'building',
    error: null,
    updatedAt: Date.now(),
  };
  saveIntent(updated, storage);
  saveLock(intent.kind, intent.address, intent.tier, intent.key, storage);
  return updated;
}

export function markAwaitingSignature(
  intent: PaymentIntent,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  return transition(intent, { status: 'awaiting_signature' }, storage);
}

export function markSubmitted(
  intent: PaymentIntent,
  txHash: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  return transition(intent, { status: 'submitted', txHash }, storage);
}

/**
 * The tx hash has been handed to the confirmation poller (issue #141) and
 * is actively being watched for inclusion — distinct from `submitted`,
 * which only means a hash exists.
 */
export function markPending(
  intent: PaymentIntent,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  return transition(intent, { status: 'pending' }, storage);
}

export function markConfirmed(
  intent: PaymentIntent,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  const updated = transition(intent, { status: 'confirmed' }, storage);
  releaseLock(intent.kind, intent.address, intent.tier, storage);
  return updated;
}

/**
 * Also releases the operation lock — a rejected/cancelled/failed
 * submission must never leave a stuck lock blocking all future
 * submissions for this operation (issue #140 edge case: wallet rejects
 * signing after `awaiting_signature`).
 */
export function markFailed(
  intent: PaymentIntent,
  error: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  const updated = transition(intent, { status: 'failed', error }, storage);
  releaseLock(intent.kind, intent.address, intent.tier, storage);
  return updated;
}

/**
 * The confirmation poller gave up before the hash ever resolved to a
 * terminal on-chain outcome (still NOT_FOUND past the poll deadline) —
 * distinct from `failed`: nothing confirmed the transaction was rejected,
 * only that we stopped waiting. Also releases the operation lock, same
 * reasoning as `markFailed`: the user must be able to retry rather than be
 * stuck behind a lock for a transaction whose outcome is unknown.
 */
export function markExpired(
  intent: PaymentIntent,
  error: string,
  storage: StorageLike = defaultStorage(),
): PaymentIntent {
  const updated = transition(intent, { status: 'expired', error }, storage);
  releaseLock(intent.kind, intent.address, intent.tier, storage);
  return updated;
}

function transition(
  intent: PaymentIntent,
  patch: Partial<PaymentIntent>,
  storage: StorageLike,
): PaymentIntent {
  const current = loadIntent(intent.key, storage) ?? intent;
  const updated: PaymentIntent = { ...current, ...patch, updatedAt: Date.now() };
  saveIntent(updated, storage);
  return updated;
}
