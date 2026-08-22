'use client';

import { useState, useEffect } from 'react';

export interface HarvestRecord {
  date: string;
  ledger: number;
  yieldAmount: number;
  bounty: number;
  caller: string;
}

export interface LastHarvestData {
  timestamp: number | null;
  ledger: number | null;
  cooldownRemaining: number;
  estimatedYield: number;
  history: HarvestRecord[];
  isLoading: boolean;
  error: string | null;
}

const COOLDOWN_SECONDS = 604_800;

const CALLERS = [
  'GABCDXXXX...YYYY',
  'GEFGHXXXX...YYYY',
  'GIJKLXXXX...YYYY',
  'GMNOPXXXX...YYYY',
];

export function useLastHarvest(): LastHarvestData {
  const [data, setData] = useState<LastHarvestData>({
    timestamp: null,
    ledger: null,
    cooldownRemaining: COOLDOWN_SECONDS,
    estimatedYield: 0,
    history: [],
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    // Audited for issue #141's stubbed-data pattern: unlike usePosition
    // (which had a real VaultRouter contract to call and was fixed to
    // reflect that), there is no deployed Harvester contract or indexer
    // this hook could call yet — the RPC layer here has nothing real to
    // wire to until GF-12 lands. Left as an explicit, tracked stub rather
    // than aligned with usePosition's fix.
    // TODO(GF-12): Replace with Harvester contract Soroban RPC call
    const lastTimestamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const elapsed = Math.floor((Date.now() - lastTimestamp) / 1000);
    const cooldownRemaining = Math.max(0, COOLDOWN_SECONDS - elapsed);

    const history: HarvestRecord[] = Array.from({ length: 20 }, (_, i) => {
      const yieldAmount = 1200 + Math.floor(Math.abs(Math.sin(i * 1.3)) * 800);
      return {
        date: new Date(lastTimestamp - i * COOLDOWN_SECONDS * 1000).toISOString(),
        ledger: 4_982_720 - i * 17_280,
        yieldAmount,
        bounty: Math.round(yieldAmount * 0.001 * 100) / 100,
        caller: CALLERS[i % CALLERS.length],
      };
    });

    setData({
      timestamp: lastTimestamp,
      ledger: 4_982_720,
      cooldownRemaining,
      estimatedYield: 1_450,
      history,
      isLoading: false,
      error: null,
    });
  }, []);

  return data;
}
