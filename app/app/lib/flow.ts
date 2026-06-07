import { aggregate_signatures } from "./wasm";

type RequestFn = (m: string, p: unknown) => Promise<any>;

export interface BuiltBundle {
  coin_spends: unknown[];
  issuer_partial_sig_hex?: string | null;
}

// chia's node RPC (coinset) requires 0x-prefixed hex; the WASM serde emits plain
// hex. Prefix the coin-spend hex fields before pushing.
const hx = (s: unknown): unknown =>
  typeof s === "string" && s.length > 0 && !s.startsWith("0x") ? `0x${s}` : s;

function normalizePushSpend(cs: any) {
  return {
    coin: {
      parent_coin_info: hx(cs.coin?.parent_coin_info),
      puzzle_hash: hx(cs.coin?.puzzle_hash),
      amount: cs.coin?.amount,
    },
    puzzle_reveal: hx(cs.puzzle_reveal),
    solution: hx(cs.solution),
  };
}

// Build (WASM) → sign (Sage) → aggregate → broadcast (coinset.org push_tx).
export async function signAndBroadcast(request: RequestFn, built: BuiltBundle): Promise<string> {
  const resp = await request("chip0002_signCoinSpends", {
    coinSpends: built.coin_spends,
    partialSign: true,
  });
  // Sage returns the sig as a string or under a field — normalize.
  const walletSig: string =
    typeof resp === "string"
      ? resp
      : (resp?.signature ?? resp?.aggregatedSignature ?? resp?.aggregated_signature ?? "");
  if (!walletSig) throw new Error("Sage did not return a signature");

  const sigs = built.issuer_partial_sig_hex ? [walletSig, built.issuer_partial_sig_hex] : [walletSig];
  const aggregated = aggregate_signatures(sigs);

  const r = await fetch("https://api.coinset.org/push_tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      spend_bundle: {
        coin_spends: (built.coin_spends as any[]).map(normalizePushSpend),
        aggregated_signature: aggregated,
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  // eslint-disable-next-line no-console
  console.log("push_tx response", j);

  const status = String(j?.status ?? "").toUpperCase();
  // Require an EXPLICIT positive acknowledgement — never treat an empty/garbled
  // 200 body as success (which would tell the user they paid when they didn't).
  const ok = !j?.error && j?.success !== false && (j?.success === true || status === "SUCCESS" || status === "PENDING");
  if (!ok) {
    throw new Error(`Node rejected the transaction: ${j?.error ?? j?.status ?? "no acknowledgement from node"}`);
  }
  return status || "SUCCESS";
}
