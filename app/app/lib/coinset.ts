// Minimal read access to a Chia full node via coinset.org (mainnet). Used for
// discovery + tracking annuity coins; broadcast lives in flow.ts.
import { with0x } from "./format";

const BASE = "https://api.coinset.org";

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export interface CoinRecord {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: number };
  spent: boolean;
  spent_block_index: number;
}

export function getCoinRecordByName(name: string): Promise<{ coin_record?: CoinRecord }> {
  return post("/get_coin_record_by_name", { name });
}

export function getCoinRecordsByHint(
  hint: string,
  includeSpent = false,
): Promise<{ coin_records?: CoinRecord[] }> {
  return post("/get_coin_records_by_hint", { hint, include_spent_coins: includeSpent });
}

export function getCoinRecordsByPuzzleHash(
  puzzleHash: string,
  includeSpent = false,
): Promise<{ coin_records?: CoinRecord[] }> {
  return post("/get_coin_records_by_puzzle_hash", {
    puzzle_hash: puzzleHash,
    include_spent_coins: includeSpent,
  });
}

export interface CoinSpendJson {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: number };
  puzzle_reveal: string;
  solution: string;
}

// The puzzle_reveal + solution of a SPENT coin (needed to walk the parent chain).
export function getPuzzleAndSolution(
  coinId: string,
  height: number,
): Promise<{ coin_solution?: CoinSpendJson }> {
  return post("/get_puzzle_and_solution", { coin_id: coinId, height });
}

export interface ConfirmProgress {
  status: "pending" | "confirmed" | "timeout";
  confirmations: number;
  eventHeight?: number;
  peakHeight?: number;
}

// Watch an INPUT coin of a broadcast bundle until it is spent on-chain — the
// uniform "did the bundle land?" signal (mirrors the cXCH reference).
export async function waitForConfirmation(
  coinId: string,
  opts: { confirmations?: number; onProgress?: (p: ConfirmProgress) => void; timeoutMs?: number } = {},
): Promise<ConfirmProgress> {
  const want = opts.confirmations ?? 1;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let progress: ConfirmProgress = { status: "pending", confirmations: 0 };
  while (Date.now() < deadline) {
    try {
      const rec = await getCoinRecordByName(with0x(coinId));
      const r = rec.coin_record;
      if (r && r.spent) {
        progress = { status: "confirmed", confirmations: want, eventHeight: r.spent_block_index };
        opts.onProgress?.(progress);
        return progress;
      }
    } catch {
      /* transient — keep polling */
    }
    opts.onProgress?.(progress);
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { status: "timeout", confirmations: 0 };
}
