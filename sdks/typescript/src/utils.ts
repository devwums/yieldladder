/**
 * Formats a USDC amount string to a human-readable string with 2 decimal places.
 *
 * @param amount - Decimal string (e.g. "500.0000000" or "500").
 * @returns Amount formatted to 2 decimal places (e.g. "500.00").
 */
export function formatUSDC(amount: string): string {
  const num = parseFloat(amount);
  if (isNaN(num)) {
    throw new Error(`Invalid USDC amount: "${amount}"`);
  }
  return num.toFixed(2);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
