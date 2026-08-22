import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  waitForTransaction,
  TransactionFailedError,
  TransactionTimedOutError,
} from './rpc';
import type { IntentStatus } from '../lib/paymentIntent';

function jsonRpcResponse(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as Response;
}

describe('waitForTransaction (issue #141)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('resolves as soon as getTransaction reports SUCCESS', async () => {
    fetchMock.mockResolvedValueOnce(jsonRpcResponse({ status: 'SUCCESS' }));
    const statuses: IntentStatus[] = [];

    await waitForTransaction('hash-1', { onStatus: (s) => statuses.push(s) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['pending', 'confirmed']);
  });

  it('keeps polling through NOT_FOUND (still propagating) until it resolves to SUCCESS', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse({ status: 'NOT_FOUND' }))
      .mockResolvedValueOnce(jsonRpcResponse({ status: 'NOT_FOUND' }))
      .mockResolvedValueOnce(jsonRpcResponse({ status: 'SUCCESS' }));

    await waitForTransaction('hash-2', { pollIntervalMs: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects with TransactionFailedError when included but failed on-chain — never reports confirmed', async () => {
    fetchMock.mockResolvedValueOnce(jsonRpcResponse({ status: 'FAILED' }));
    const statuses: IntentStatus[] = [];

    await expect(
      waitForTransaction('hash-3', { onStatus: (s) => statuses.push(s) }),
    ).rejects.toBeInstanceOf(TransactionFailedError);
    expect(statuses).toEqual(['pending', 'failed']);
  });

  it('rejects with TransactionTimedOutError if it never leaves NOT_FOUND before the deadline', async () => {
    fetchMock.mockResolvedValue(jsonRpcResponse({ status: 'NOT_FOUND' }));
    const statuses: IntentStatus[] = [];

    await expect(
      waitForTransaction('hash-4', {
        pollIntervalMs: 1,
        timeoutMs: 5,
        onStatus: (s) => statuses.push(s),
      }),
    ).rejects.toBeInstanceOf(TransactionTimedOutError);
    expect(statuses[0]).toBe('pending');
    expect(statuses[statuses.length - 1]).toBe('expired');
  });
});
