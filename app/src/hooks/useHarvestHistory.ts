'use client';

import { useState, useEffect } from 'react';

export interface HarvestEvent {
  id: string;
  date: string;
  ledger: number;
  yieldAmount: number;
  bounty: number;
  caller: string;
}

export interface HarvestHistoryData {
  events: HarvestEvent[];
  isLoading: boolean;
  error: string | null;
}

const CALLERS = [
  'GABCDXXXX...YYYY',
  'GEFGHXXXX...YYYY',
  'GIJKLXXXX...YYYY',
  'GMNOPXXXX...YYYY',
];

export function useHarvestHistory(limit = 20): HarvestHistoryData {
  const [data, setData] = useState<HarvestHistoryData>({
    events: [],
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    // Audited for issue #141's stubbed-data pattern (see the identical
    // note in useLastHarvest.ts): no real event indexer exists yet to
    // wire this to, unlike usePosition's VaultRouter call. Left as an
    // explicit, tracked stub.
    // TODO(GF-12): Replace with real event indexer queries
    const now = Date.now();
    const events: HarvestEvent[] = Array.from({ length: limit }, (_, i) => {
      const yieldAmount = 1200 + Math.floor(Math.abs(Math.sin(i * 1.3)) * 800);
      return {
        id: `harvest-${i}`,
        date: new Date(now - i * 7 * 24 * 60 * 60 * 1000).toISOString(),
        ledger: 5_000_000 - i * 17_280,
        yieldAmount,
        bounty: Math.round(yieldAmount * 0.001 * 100) / 100,
        caller: CALLERS[i % CALLERS.length],
      };
    });
    setData({ events, isLoading: false, error: null });
  }, [limit]);

  return data;
}
