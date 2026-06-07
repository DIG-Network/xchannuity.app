// Display/parse helpers for CAT mojo amounts and vesting times.

export const strip0x = (s: string): string => (s.startsWith("0x") ? s.slice(2) : s);
export const with0x = (s: string): string => (s.startsWith("0x") ? s : `0x${s}`);

export function fromMojos(mojos: number | bigint, decimals: number): string {
  const m = BigInt(mojos);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = m / base;
  const frac = m % base;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

// cMOJO is XCH wrapped 1:1 by mojo, so its CAT-mojo amount IS an XCH-mojo
// amount. Render it as XCH (12 decimals).
export function mojosToXch(mojos: bigint | number): string {
  return fromMojos(BigInt(mojos), 12);
}

export function toMojos(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || "0");
}

export function humanCountdown(endUnix: number, nowUnix: number): string {
  const s = endUnix - nowUnix;
  if (s <= 0) return "fully vested";
  const d = Math.floor(s / 86400);
  if (d >= 365) return `vests fully in ${(d / 365).toFixed(1)} years`;
  if (d >= 30) return `vests fully in ${Math.round(d / 30)} months`;
  if (d >= 1) return `vests fully in ${d} days`;
  return `vests fully in ${Math.floor(s / 3600)} hours`;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// Vested-now amount (pure JS, matches the puzzle: clamp to [last,end], floor div).
// Uses BigInt so large mojo amounts don't lose precision.
export function claimableMojos(principal: number, end: number, last: number, now: number): number {
  if (end <= last) return 0;
  const pt = Math.min(Math.max(now, last), end);
  return Number((BigInt(principal) * BigInt(pt - last)) / BigInt(end - last));
}

export function vestProgress(start: number, end: number, now: number): number {
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}
