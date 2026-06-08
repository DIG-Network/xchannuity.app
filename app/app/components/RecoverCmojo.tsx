"use client";

// Fallback recovery widget. The claim/clawback flows auto-melt their cMOJO
// payout → XCH, but that second leg can be interrupted (user cancels, wallet
// closes, network blips) leaving cMOJO parked in the wallet. This subtle banner
// detects any leftover cMOJO (never named as such — shown as "XCH waiting to be
// converted") and offers a one-signature melt of ALL of it back to native XCH.
//
// Detection: Sage knows the wallet's cMOJO coins by asset id. We never surface
// cMOJO to the user; the banner only appears when a balance exists.

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useSage } from "../lib/walletconnect";
import { useSpendConfirm, type SpendSummaryLine } from "./SpendConfirm";
import {
  getAssetCoins,
  getPublicKeys,
  getAddress,
  normalizeCoin,
  normalizeLineageProof,
  buildCatKeyResolver,
  buildKeyResolver,
  extractCoinName,
  sumCoinAmounts,
} from "../lib/sage";
import { cmojoAssetId, meltToXch, devFeeMojos } from "../lib/cmojo";
import { address_to_puzzle_hash } from "../lib/wasm";
import { mojosToXch } from "../lib/format";

export function RecoverCmojo({ onChange }: { onChange?: () => void }) {
  const { request, session } = useSage();
  const { runSpend, active } = useSpendConfirm();
  const [leftover, setLeftover] = useState<bigint>(0n);
  const [coinCount, setCoinCount] = useState(0);

  const scan = useCallback(async () => {
    if (!session) {
      setLeftover(0n);
      setCoinCount(0);
      return;
    }
    try {
      const coins = await getAssetCoins(request, "cat", cmojoAssetId());
      setLeftover(sumCoinAmounts(coins));
      setCoinCount(coins.length);
    } catch {
      setLeftover(0n);
      setCoinCount(0);
    }
  }, [request, session]);

  useEffect(() => {
    scan();
  }, [scan]);

  // Re-scan whenever a spend modal closes — picks up a freshly-stranded coin
  // after an interrupted melt, or clears the banner once a recovery confirms.
  useEffect(() => {
    if (!active) scan();
  }, [active, scan]);

  if (!session || leftover <= 0n) return null;

  function doMelt() {
    runSpend({
      title: "Convert to XCH",
      confirmLabel: "Convert to XCH",
      prepare: async (report) => {
        report("Scanning your wallet…");
        const raw = await getAssetCoins(request, "cat", cmojoAssetId());
        if (raw.length === 0) throw new Error("Nothing left to convert.");

        report("Resolving authorization…");
        const keys = await getPublicKeys(request);
        const catResolver = buildCatKeyResolver(keys, cmojoAssetId());
        const xchResolver = buildKeyResolver(keys);

        const cmojoCoins = raw.map((r) => {
          const coin = normalizeCoin(r);
          const synthetic_key = catResolver(coin.puzzle_hash);
          if (!synthetic_key) throw new Error("A leftover coin isn't controlled by this wallet.");
          return {
            coin,
            lineage_proof: normalizeLineageProof(
              (r as Record<string, unknown>).lineageProof ?? (r as Record<string, unknown>).lineage_proof,
            ),
            synthetic_key,
          };
        });
        const totalMojos = cmojoCoins.reduce((s, c) => s + BigInt(c.coin.amount), 0n);

        report("Selecting an XCH anchor coin…");
        const xch = await getAssetCoins(request, null, null);
        if (xch.length === 0) {
          throw new Error("Keep a small XCH coin in your wallet to convert.");
        }
        const anchorRaw = xch[0];
        const anchorCoin = normalizeCoin(anchorRaw);
        const anchorKey = xchResolver(anchorCoin.puzzle_hash);
        if (!anchorKey) throw new Error("This wallet doesn't control its own XCH anchor coin.");

        report("Resolving your receive address…");
        const walletPh = address_to_puzzle_hash(await getAddress(request));

        report("Building conversion bundle…");
        const melt = await meltToXch({
          cmojoCoins,
          anchorCoins: [{ coin: anchorCoin, synthetic_key: anchorKey }],
          recipientPh: walletPh,
          catChangePh: walletPh,
          meltMojos: totalMojos,
          feeMojos: 0n,
        });

        const summary: SpendSummaryLine[] = [
          { label: "Convert", value: `${mojosToXch(totalMojos)} XCH`, strong: true },
          { label: "From", value: `${cmojoCoins.length} pending coin${cmojoCoins.length === 1 ? "" : "s"}` },
          { label: "Conversion fee", value: `${mojosToXch(devFeeMojos(totalMojos))} XCH` },
        ];
        return {
          built: {
            coin_spends: melt.coin_spends,
            issuer_partial_sig_hex: melt.issuer_partial_signature,
          },
          summary,
          watchCoinId: extractCoinName(anchorRaw),
        };
      },
    })
      .then(() => {
        toast.success("Converted to XCH");
        scan();
        onChange?.();
      })
      .catch(() => {});
  }

  return (
    <div
      className="fade-in flex flex-wrap items-center justify-between gap-3 rounded-[var(--r-md)] px-4 py-3"
      style={{
        border: "1px solid var(--accent-soft-2)",
        background: "var(--accent-soft)",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm"
          style={{ background: "var(--accent-soft-2)", color: "var(--accent-bright)" }}
          aria-hidden
        >
          ↻
        </span>
        <p className="text-sm leading-snug text-[var(--fg-muted)]">
          <span className="font-mono-num font-semibold text-[var(--fg)]">{mojosToXch(leftover)} XCH</span>{" "}
          from a previous claim is waiting to finish converting
          {coinCount > 1 ? ` (${coinCount} pending coins)` : ""}.
        </p>
      </div>
      <button onClick={doMelt} className="btn btn-primary btn-sm shrink-0">
        Convert to XCH
      </button>
    </div>
  );
}
