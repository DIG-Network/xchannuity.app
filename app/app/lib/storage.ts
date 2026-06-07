// Local cache of annuities this browser created/loaded. The chain is the source
// of truth; this is convenience only (mirrors streaming-ui's savedStreams).

export interface StoredAnnuity {
  streamId: string; // 0x eve coin id
  assetId: string;
  recipient: string; // 0x puzzle hash
  clawbackPh: string | null;
  startTime: number;
  endTime: number;
  lastPaymentTime: number;
  principalMojos: number; // CURRENT remaining coin amount (advances down as claimed)
  totalMojos: number; // original streamed total (net of fee); constant
  createdAt: number;
}

const KEY = "xchannuity:annuities";

export function loadAnnuities(): StoredAnnuity[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveAnnuity(a: StoredAnnuity): void {
  const all = loadAnnuities().filter((x) => x.streamId !== a.streamId);
  all.unshift(a);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function removeAnnuity(streamId: string): void {
  localStorage.setItem(
    KEY,
    JSON.stringify(loadAnnuities().filter((x) => x.streamId !== streamId)),
  );
}
