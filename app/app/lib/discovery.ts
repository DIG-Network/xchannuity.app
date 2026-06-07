// Stateless on-chain discovery of the connected wallet's annuities.
//
// Annuity coins are hinted to the beneficiary's puzzle hash (launch-hint memos),
// so we list them with getCoinRecordsByHint(recipient) — the hint MUST be
// 0x-prefixed for the node. For each unspent coin we fetch its PARENT's spend
// and hand it to the WASM parser (discover_from_parent), which reconstructs the
// live AnnuityInfo (current last_payment_time after claims; new owner after a
// transfer). Any CAT wrapping our streaming puzzle is accepted — including
// custom (non-allow-listed) asset ids.

import { discover_from_parent } from "./wasm";
import { getCoinRecordsByHint, getCoinRecordByName, getPuzzleAndSolution } from "./coinset";
import { with0x } from "./format";
import type { StoredAnnuity } from "./storage";

const norm = (s: string) => s.replace(/^0x/, "").toLowerCase();

export interface LiveCoin {
  coin: { parent_coin_info: string; puzzle_hash: string; amount: number };
  lineage_proof: { parent_parent_coin_info: string; parent_inner_puzzle_hash: string; parent_amount: number };
}
export interface RichAnnuity extends LiveCoin {
  stored: StoredAnnuity;
}

// Walk: hint(recipient) → unspent coins → parent spend → parser.
export async function discoverRich(recipientPh: string): Promise<RichAnnuity[]> {
  const hint = norm(recipientPh);
  const res = await getCoinRecordsByHint(with0x(recipientPh), false);
  const records = (res.coin_records ?? []).filter((r) => !r.spent);

  const out: RichAnnuity[] = [];
  const seen = new Set<string>();

  for (const rec of records) {
    try {
      const parentId = rec.coin.parent_coin_info;
      const parentRec = await getCoinRecordByName(parentId);
      if (!parentRec.coin_record) continue;
      const ps = await getPuzzleAndSolution(parentId, parentRec.coin_record.spent_block_index);
      if (!ps.coin_solution) continue;

      const d: any = discover_from_parent(parentRec.coin_record.coin, ps.coin_solution.puzzle_reveal, ps.coin_solution.solution);
      if (!d) continue;

      // keep only the child that IS this coin and is owned by the wallet
      if (norm(d.coin.puzzle_hash) !== norm(rec.coin.puzzle_hash)) continue;
      if (norm(d.recipient) !== hint) continue;
      if (seen.has(d.stream_id)) continue;
      seen.add(d.stream_id);

      out.push({
        coin: d.coin,
        lineage_proof: d.lineage_proof,
        stored: {
          streamId: d.stream_id,
          assetId: d.asset_id,
          recipient: d.recipient,
          clawbackPh: d.clawback_ph ?? null,
          startTime: d.last_payment_time,
          endTime: d.end_time,
          lastPaymentTime: d.last_payment_time,
          principalMojos: d.amount, // current remaining
          totalMojos: d.amount, // overridden by the local-cache merge if known
          createdAt: d.last_payment_time,
        },
      });
    } catch {
      /* skip coins we can't walk */
    }
  }

  return out;
}

export async function discoverAnnuities(recipientPh: string): Promise<StoredAnnuity[]> {
  return (await discoverRich(recipientPh)).map((r) => r.stored);
}

// Resolve the live coin + lineage + CURRENT params for a specific annuity (used
// by claim/transfer/sell). Returns the rich match so callers can read the live
// recipient/last_payment_time/amount (post-claim/post-transfer) rather than a
// possibly-stale local cache.
export async function resolveLive(a: StoredAnnuity): Promise<RichAnnuity> {
  const rich = await discoverRich(a.recipient);
  const match =
    rich.find(
      (r) => norm(r.stored.assetId) === norm(a.assetId) && r.stored.endTime === a.endTime,
    ) ?? rich[0];
  if (!match) throw new Error("Annuity coin not found on-chain (still confirming?)");
  return match;
}
