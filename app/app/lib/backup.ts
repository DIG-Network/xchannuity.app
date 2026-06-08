// `.xchannuity` backup file: a portable, self-describing JSON snapshot of one
// annuity holding everything needed to find it on chain again — the launcher
// (eve) coin id, the beneficiary hint, the curried params and amounts. The chain
// is the source of truth; this lets a user re-import an annuity the local cache
// lost, or hand it to another wallet/app.

import type { StoredAnnuity } from "./storage";
import { CHAIN_ID } from "./walletconnect";

export const XCHANNUITY_FILE_FORMAT = "xchannuity-annuity";
export const XCHANNUITY_FILE_VERSION = 1;

export interface XchannuityBackup {
  format: typeof XCHANNUITY_FILE_FORMAT;
  version: number;
  network: string; // e.g. "chia:mainnet"
  exportedAt: number; // unix seconds
  annuity: StoredAnnuity & {
    // Interop aliases for other applications. `launcherId` is the eve coin id
    // (our `streamId`); `hint` is the beneficiary puzzle hash (our `recipient`).
    launcherId: string;
    hint: string;
  };
}

export function buildBackup(a: StoredAnnuity, exportedAt: number): XchannuityBackup {
  return {
    format: XCHANNUITY_FILE_FORMAT,
    version: XCHANNUITY_FILE_VERSION,
    network: CHAIN_ID,
    exportedAt,
    annuity: { ...a, launcherId: a.streamId, hint: a.recipient },
  };
}

/** Short, human-friendly filename for a backup, e.g. `annuity-1a2b3c4d.xchannuity`. */
export function backupFilename(a: StoredAnnuity): string {
  const id = a.streamId.replace(/^0x/, "").slice(0, 8) || "annuity";
  return `annuity-${id}.xchannuity`;
}

export function downloadBackup(a: StoredAnnuity, exportedAt: number): void {
  const blob = new Blob([JSON.stringify(buildBackup(a, exportedAt), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFilename(a);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Parse + validate a `.xchannuity` file's text into a StoredAnnuity. Accepts both
 * our canonical field names and the interop aliases (launcherId/hint). Throws a
 * clear error if the file is malformed or missing required fields.
 */
export function parseBackup(text: string): StoredAnnuity {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Not a valid .xchannuity file (invalid JSON).");
  }
  const root = doc as Record<string, unknown>;
  // Accept either the wrapped backup (root.annuity) or a bare annuity object.
  const src = (root.annuity ?? root) as Record<string, unknown>;

  const streamId = asString(src.streamId) ?? asString(src.launcherId);
  const recipient = asString(src.recipient) ?? asString(src.hint);
  const assetId = asString(src.assetId);
  const startTime = asNumber(src.startTime);
  const endTime = asNumber(src.endTime);
  const lastPaymentTime = asNumber(src.lastPaymentTime);
  const principalMojos = asNumber(src.principalMojos);
  const totalMojos = asNumber(src.totalMojos);

  if (!streamId) throw new Error("Backup is missing the launcher/stream id.");
  if (!recipient) throw new Error("Backup is missing the beneficiary hint.");
  if (assetId === undefined) throw new Error("Backup is missing the asset id.");
  if (endTime === undefined || lastPaymentTime === undefined) {
    throw new Error("Backup is missing the vesting window.");
  }

  const clawbackRaw = src.clawbackPh;
  const clawbackPh =
    clawbackRaw === null || clawbackRaw === undefined || clawbackRaw === ""
      ? null
      : asString(clawbackRaw) ?? null;

  return {
    streamId,
    assetId,
    recipient,
    clawbackPh,
    startTime: startTime ?? lastPaymentTime,
    endTime,
    lastPaymentTime,
    principalMojos: principalMojos ?? totalMojos ?? 0,
    totalMojos: totalMojos ?? principalMojos ?? 0,
    createdAt: asNumber(src.createdAt) ?? endTime,
  };
}
