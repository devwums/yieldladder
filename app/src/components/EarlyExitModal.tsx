"use client";

import React, { useEffect, useMemo, useState } from "react";
import { loadSession } from "@/lib/wallet/session";
import {
  createIntent,
  beginSubmission,
  markAwaitingSignature,
  findActiveIntent,
  type PaymentIntent,
} from "@/lib/paymentIntent";
import { runPaymentSubmission, defaultPaymentSubmissionDeps } from "@/lib/paymentFlow";
import { toast } from "@/lib/toast";

function fixed7(n: number) {
  return Math.round(n * 1e7) / 1e7;
}

/**
 * TODO(#141 follow-up): stands in for `sdk.earlyExit({ tier, idempotencyKey
 * })` (sdks/typescript's YieldLadder) until the app depends on the SDK
 * directly — see the identical TODO on app/src/app/deposit/page.tsx's
 * placeholderSubmissionHash for why that wiring is deferred.
 */
async function placeholderEarlyExitHash(idempotencyKey: string): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(`mock-tx-${idempotencyKey}`), 2000),
  );
}

export default function EarlyExitModal({
  open,
  onClose,
  tier,
  principal,
  accruedYield,
  exitFeeRate,
  remainingDays,
}: {
  open: boolean;
  onClose: () => void;
  /** Which vault tier this position is being exited from — part of the idempotency key (issue #140). */
  tier: string;
  principal: number;
  accruedYield: number;
  exitFeeRate: number; // e.g., 0.0125
  remainingDays: number;
}) {
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<
    'idle' | 'pending' | 'confirmed' | 'failed' | 'expired'
  >('idle');
  const [error, setError] = useState('');

  const address = loadSession()?.account.publicKey ?? 'anonymous';

  // Generated once per time the modal opens (issue #140) — reopening with
  // different numbers (e.g. accrued yield ticked up) gets a fresh nonce,
  // rather than silently reusing a stale key. On open, also rehydrate any
  // still-in-flight intent from before a reload instead of starting fresh.
  useEffect(() => {
    if (!open) return;
    const active = findActiveIntent('earlyExit', address, tier);
    if (active) {
      setIntent(active);
      setStatus(
        active.status === 'confirmed'
          ? 'confirmed'
          : active.status === 'failed'
            ? 'failed'
            : 'pending',
      );
      if (active.error) setError(active.error);
      return;
    }
    setIntent(createIntent('earlyExit', address, tier, 'USDC', String(principal)));
    setStatus('idle');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleExitEarly() {
    if (!intent || submitting) return;

    const started = beginSubmission(intent);
    if (!started) return;

    setSubmitting(true);
    setIntent(started);
    setStatus('pending');

    const awaiting = markAwaitingSignature(started);
    setIntent(awaiting);

    // Real submit -> sign -> wait -> classify pipeline (issue #142), shared
    // with the deposit flow via lib/paymentFlow.ts — see that module's docs
    // for why real failures (network/wallet/on-chain) are reachable here
    // via injected test doubles rather than only this manual UI trigger.
    const result = await runPaymentSubmission(awaiting, {
      ...defaultPaymentSubmissionDeps,
      submit: placeholderEarlyExitHash,
    });

    setIntent(result.intent);
    setStatus(result.status);
    if (result.message) {
      setError(result.message);
      toast.failed(result.message);
    }
    setSubmitting(false);
  }

  const calc = useMemo(() => {
    const p = fixed7(principal);
    const y = fixed7(accruedYield);
    const fee = fixed7(p * exitFeeRate);
    const net = fixed7(p + y - fee);
    const ifMature = fixed7(p + y + 0); // assume current accrued yield is total at maturity in this minimal impl
    const opportunity = fixed7(ifMature - net);
    return { p, y, fee, net, ifMature, opportunity };
  }, [principal, accruedYield, exitFeeRate]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{ background: "#fff", padding: 20, width: 480, borderRadius: 8 }}
      >
        <h3>Confirm Early Exit</h3>
        <div style={{ borderTop: "1px solid #eee", paddingTop: 12 }}>
          <div>
            Current principal: <strong>{calc.p.toFixed(2)} USDC</strong>
          </div>
          <div>
            Accrued yield: <strong>+{calc.y.toFixed(2)} USDC</strong>
          </div>
          <div>
            Early exit fee ({(exitFeeRate * 100).toFixed(2)}%):{" "}
            <strong>-{calc.fee.toFixed(2)} USDC</strong>
          </div>
          <div
            style={{ borderTop: "1px solid #ddd", marginTop: 8, paddingTop: 8 }}
          >
            You will receive: <strong>{calc.net.toFixed(2)} USDC</strong>
          </div>
          <div style={{ marginTop: 8 }}>
            Remaining lock: <strong>{remainingDays} days</strong>
          </div>
          <div>
            If you wait until maturity, you receive:{" "}
            <strong>~{calc.ifMature.toFixed(2)} USDC</strong>
          </div>
          <div>
            Opportunity cost of exiting now:{" "}
            <strong>~{calc.opportunity.toFixed(2)} USDC</strong>
          </div>
        </div>
        {status === 'pending' && <p>Submitting transaction…</p>}
        {status === 'confirmed' && <p>Exit confirmed.</p>}
        {status === 'failed' && <p style={{ color: '#c33' }}>{error || 'An error occurred. Please try again.'}</p>}
        {status === 'expired' && (
          <p style={{ color: '#c33' }}>
            {error || 'Could not confirm this transaction in time.'}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          <button onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            style={{
              background: submitting ? "#e88" : "#c33",
              color: "#fff",
              border: "none",
              padding: "6px 10px",
              borderRadius: 4,
              cursor: submitting ? "not-allowed" : "pointer",
            }}
            type="button"
            disabled={submitting || status === 'confirmed'}
            onClick={handleExitEarly}
          >
            {submitting
              ? 'Submitting…'
              : status === 'failed' || status === 'expired'
                ? 'Try Again'
                : 'Exit Early'}
          </button>
        </div>
      </div>
    </div>
  );
}
