"use client";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useSage } from "../lib/walletconnect";
import { useSpendConfirm, type SpendSummaryLine } from "./SpendConfirm";
import {
  build_claim,
  build_clawback,
  build_transfer,
  build_open_offer,
  encode_offer,
  coin_id,
  address_to_puzzle_hash,
  annuity_inner_puzzle_hash,
} from "../lib/wasm";
import Modal from "./Modal";
import { resolveLive, type RichAnnuity } from "../lib/discovery";
import { getCoinRecordsByPuzzleHash } from "../lib/coinset";
import { getPublicKeys, getAssetCoins, normalizeCoin, buildKeyResolver, getAddress, extractCoinName } from "../lib/sage";
import { tokenByAssetId, CMOJO_ASSET_ID } from "../lib/tokens";
import { meltToXch, cmojoOuterPh, devFeeMojos } from "../lib/cmojo";
import { fromMojos, mojosToXch, toMojos, claimableMojos, nowUnix } from "../lib/format";
import { removeAnnuity, type StoredAnnuity } from "../lib/storage";

// Provably-unspendable burn target: the all-zeros puzzle hash. No puzzle reveal
// can satisfy the stream layer's `tree_hash(owner) == 0x00…00` check, so a
// transfer here yields a permanently unspendable STREAM<0x00…00> coin — the
// annuity is destroyed (value unrecoverable). Burn reuses the audited TRANSFER
// path; no on-chain change.
const BURN_PH = "0x" + "00".repeat(32);

// A statement line: muted label left, right-aligned tabular figure, hairline rule.
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 border-t py-2.5 first:border-t-0"
      style={{ borderColor: "var(--border)" }}
    >
      <dt className="text-[var(--fg-muted)]">{label}</dt>
      <dd className="font-mono-num tabular-nums text-[var(--fg)]">{value}</dd>
    </div>
  );
}

export function AnnuityCard({
  a,
  onChange,
  role = "owner",
}: {
  a: StoredAnnuity;
  onChange: () => void;
  role?: "owner" | "issuer";
}) {
  const { request } = useSage();
  const { runSpend } = useSpendConfirm();
  const [now, setNow] = useState(nowUnix());
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferAddr, setTransferAddr] = useState("");
  const [sellOpen, setSellOpen] = useState(false);
  const [sellPrice, setSellPrice] = useState("");
  const [sellBusy, setSellBusy] = useState(false);
  const [offerResult, setOfferResult] = useState<string | null>(null);
  const [burnOpen, setBurnOpen] = useState(false);
  const [burnConfirm, setBurnConfirm] = useState("");

  useEffect(() => {
    const id = setInterval(() => setNow(nowUnix()), 1000);
    return () => clearInterval(id);
  }, []);

  const token = tokenByAssetId(a.assetId);
  const decimals = token?.decimals ?? 3;
  const isCmojo = token?.symbol === "cMOJO";
  // XCH annuities are cMOJO CATs under the hood: after CLAIM pays vested cMOJO,
  // we auto-melt that cMOJO → native XCH via a second signed spend.
  const isXch = a.assetId.toLowerCase() === CMOJO_ASSET_ID.toLowerCase();
  const fmt = (m: number) => (isCmojo ? `${mojosToXch(m)} XCH` : `${fromMojos(m, decimals)} ${token?.symbol ?? "CAT"}`);

  // streaming-ui breakdown: claimed | claimable | to-stream, of the original total.
  const total = a.totalMojos || a.principalMojos;
  const remaining = a.principalMojos;
  const claimed = Math.max(0, total - remaining);
  const claimable = claimableMojos(remaining, a.endTime, a.lastPaymentTime, now);
  const toStream = Math.max(0, remaining - claimable);
  const pctOf = (m: number) => (total > 0 ? Math.max(0, Math.min(100, (m / total) * 100)) : 0);

  // Resolve the synthetic key controlling the owner's p2 puzzle hash `ph`. Used
  // for CLAIM / TRANSFER / SELL: the owner authorizes by revealing + running this
  // key's standard p2 (Sage partial-signs the inner AGG_SIG). No message coin.
  async function resolveOwnerKey(ph: string): Promise<string> {
    const ownerKey = buildKeyResolver(await getPublicKeys(request))(ph);
    if (!ownerKey) throw new Error("This wallet doesn't control this annuity's owner address");
    return ownerKey;
  }

  // CLAWBACK only: the issuer authorizes via a mode-23 message from an XCH coin at
  // the clawback authority `ph`. Resolve that key + the message-sending coin.
  async function resolveAuthorizer(ph: string) {
    const keys = await getPublicKeys(request);
    const ownerKey = buildKeyResolver(keys)(ph);
    if (!ownerKey) throw new Error("This wallet doesn't control the clawback authority address");
    const xch = await getAssetCoins(request, null, null);
    const msgRaw = xch.find((r) => normalizeCoin(r).puzzle_hash.toLowerCase() === ph.toLowerCase());
    if (!msgRaw)
      throw new Error("Send a little XCH to the clawback address first (it sends the on-chain message).");
    return { ownerKey, owner_coin: normalizeCoin(msgRaw) };
  }

  const params = () => ({
    recipient: a.recipient,
    clawback_ph: a.clawbackPh,
    end_time: a.endTime,
    last_payment_time: a.lastPaymentTime,
  });

  function doClaim() {
    // Captured from the claim's prepare() so the follow-on melt can reconstruct
    // the just-claimed cMOJO payout coin (XCH annuities only).
    let claimedLive: RichAnnuity | null = null;
    let claimedMojos = 0;
    runSpend({
      title: `Claim ${token?.symbol ?? "CAT"} annuity`,
      confirmLabel: "Claim",
      prepare: async (report) => {
        report("Locating the annuity coin…");
        const live = await resolveLive(a);
        report("Resolving authorization…");
        const ownerKey = await resolveOwnerKey(a.recipient);
        report("Building spend bundle…");
        // ASSERT_SECONDS_ABSOLUTE checks the last block timestamp (lags wall
        // clock), so claim slightly in the past — matches streaming-ui.
        const t = nowUnix() - 120;
        const built: any = build_claim({
          params: params(),
          annuity_coin: live.coin,
          lineage_proof: live.lineage_proof,
          asset_id: a.assetId,
          owner_synthetic_key: ownerKey,
          time: t,
        });
        // Capture the live coin + the EXACT paid amount for the auto-melt.
        // CRITICAL: the puzzle pays the vested amount at the clamped claim time
        // `t` (= now-120), NOT at `now`. The melt reconstructs the payout coin by
        // id = sha256(parent, ph, amount); using `claimable`@now here makes the
        // amount (and id) wrong → the melt hits UNKNOWN_UNSPENT. Recompute at `t`
        // with the coin's actual amount (what build_claim used as my_amount), so
        // it byte-matches the on-chain payout (claimableMojos mirrors the puzzle).
        claimedLive = live;
        claimedMojos = claimableMojos(Number(live.coin.amount), a.endTime, a.lastPaymentTime, t);
        const watch = coin_id(live.coin.parent_coin_info, live.coin.puzzle_hash, BigInt(live.coin.amount));
        const summary: SpendSummaryLine[] = [
          { label: "Claiming", value: fmt(claimable), strong: true },
          { label: "From", value: `${token?.symbol ?? "CAT"} annuity` },
        ];
        return { built, summary, watchCoinId: watch };
      },
    })
      .then(async () => {
        toast.success("Claim confirmed");
        // XCH annuity: the claim paid vested cMOJO to the owner. Immediately
        // prompt a second signed spend that melts it → native XCH.
        if (isXch && claimedLive && claimedMojos > 0) {
          try {
            await meltCmojoPayout(claimedLive, a.recipient);
          } catch {
            // User cancelled or melt failed — claim already landed; the cMOJO is
            // claimable manually later. Don't fail the claim.
          }
        }
        onChange();
      })
      .catch(() => {});
  }

  // Melt a just-created cMOJO payout coin → native XCH. Used as the second leg
  // of both flows: a claim (payout inner p2 = the owner, `a.recipient`) and a
  // clawback (the issuer's reclaimed coin, inner p2 = `a.clawbackPh`). `live` is
  // the annuity coin that was spent (parent of the payout); `payoutPh` is the
  // inner p2 puzzle hash the cMOJO was paid to — also where the melted XCH goes.
  async function meltCmojoPayout(live: RichAnnuity, payoutPh: string) {
    return runSpend({
      title: "Withdraw to XCH",
      confirmLabel: "Melt to XCH",
      prepare: async (report) => {
        report("Locating the cMOJO payout coin on-chain…");
        // The spend consumed `live.coin`; the payout coin's parent IS its id.
        const annuityCoinId = coin_id(
          live.coin.parent_coin_info,
          live.coin.puzzle_hash,
          BigInt(live.coin.amount),
        );
        // DISCOVER the real payout coin from the node rather than reconstructing
        // its id by hand: the spend paid a CAT<cMOJO> coin (inner p2 = payoutPh,
        // outer ph = cmojoOuterPh(payoutPh)) whose parent is the spent annuity
        // coin. The node is the source of truth for the exact amount — eliminates
        // the amount/time reconstruction that previously caused UNKNOWN_UNSPENT.
        // The spend just confirmed; poll briefly to absorb node-indexing lag.
        const outerPh = cmojoOuterPh(payoutPh);
        const eq = (x: string, y: string) =>
          x.toLowerCase().replace(/^0x/, "") === y.toLowerCase().replace(/^0x/, "");
        let claimedCoin: { parent_coin_info: string; puzzle_hash: string; amount: number } | undefined;
        for (let attempt = 0; attempt < 5 && !claimedCoin; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
          const recs = await getCoinRecordsByPuzzleHash(outerPh, false);
          claimedCoin = (recs.coin_records ?? [])
            .filter((r) => !r.spent && eq(r.coin.parent_coin_info, annuityCoinId))
            .map((r) => r.coin)[0];
        }
        if (!claimedCoin) {
          throw new Error("Claimed XCH not located on-chain yet — wait a few seconds and withdraw again.");
        }
        // CAT lineage proof relative to the parent (the spent annuity coin):
        //   parent_inner_puzzle_hash = the annuity's OWN StreamLayer inner ph,
        //   computed from the same params the claim spent. (The node returns the
        //   coin, not its lineage, so this is still derived locally.)
        const parentInnerPh = annuity_inner_puzzle_hash(
          a.recipient,
          a.clawbackPh ?? undefined,
          BigInt(a.endTime),
          BigInt(a.lastPaymentTime),
        );
        const lineage_proof = {
          parent_parent_coin_info: live.coin.parent_coin_info,
          parent_inner_puzzle_hash: parentInnerPh,
          parent_amount: live.coin.amount,
        };

        report("Resolving authorization…");
        const keys = await getPublicKeys(request);
        const resolver = buildKeyResolver(keys);
        const ownerKey = await resolveOwnerKey(payoutPh);

        report("Selecting an XCH anchor coin…");
        const xch = await getAssetCoins(request, null, null);
        if (xch.length === 0) {
          throw new Error("Keep a small XCH coin in your wallet to withdraw to XCH");
        }
        const anchorRaw = xch[0];
        const anchorCoin = normalizeCoin(anchorRaw);
        const anchorKey = resolver(anchorCoin.puzzle_hash);
        if (!anchorKey) throw new Error("This wallet doesn't control its own XCH anchor coin");

        report("Building melt bundle…");
        const melt = await meltToXch({
          cmojoCoins: [{ coin: claimedCoin, lineage_proof, synthetic_key: ownerKey }],
          anchorCoins: [{ coin: anchorCoin, synthetic_key: anchorKey }],
          recipientPh: payoutPh, // native XCH goes to whoever received the cMOJO
          catChangePh: payoutPh,
          meltMojos: BigInt(claimedCoin.amount),
          feeMojos: 0n,
        });

        const summary: SpendSummaryLine[] = [
          { label: "Withdraw", value: `${mojosToXch(claimedCoin.amount)} XCH`, strong: true },
          { label: "Melt fee", value: `${mojosToXch(Number(devFeeMojos(BigInt(claimedCoin.amount))))} XCH` },
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
    });
  }

  function doTransfer(dest: string) {
    let newRecipient: string;
    try {
      newRecipient = address_to_puzzle_hash(dest.trim());
    } catch {
      toast.error("Invalid address");
      return;
    }
    runSpend({
      title: `Transfer ${token?.symbol ?? "CAT"} annuity`,
      confirmLabel: "Transfer",
      prepare: async (report) => {
        report("Locating the annuity coin…");
        const live = await resolveLive(a);
        report("Resolving authorization…");
        const ownerKey = await resolveOwnerKey(a.recipient);
        report("Building spend bundle…");
        const built: any = build_transfer({
          params: params(),
          annuity_coin: live.coin,
          lineage_proof: live.lineage_proof,
          asset_id: a.assetId,
          owner_synthetic_key: ownerKey,
          new_recipient: newRecipient,
        });
        const watch = coin_id(live.coin.parent_coin_info, live.coin.puzzle_hash, BigInt(live.coin.amount));
        const summary: SpendSummaryLine[] = [
          { label: "Annuity", value: token?.symbol ?? "CAT" },
          { label: "New owner", value: `${dest.trim().slice(0, 12)}…` },
          { label: "Value moved", value: fmt(a.principalMojos), strong: true },
        ];
        return { built, summary, watchCoinId: watch };
      },
    })
      .then(() => {
        toast.success("Transfer confirmed");
        removeAnnuity(a.streamId);
        onChange();
      })
      .catch(() => {});
  }

  // BURN — destroy the annuity by transferring it to the unspendable all-zeros
  // address. Reuses the audited TRANSFER path; the continuation STREAM<0x00…00>
  // can never be spent again. Value is permanently unrecoverable.
  function doBurn() {
    runSpend({
      title: `Burn ${token?.symbol ?? "CAT"} annuity`,
      confirmLabel: "Burn permanently",
      prepare: async (report) => {
        report("Locating the annuity coin…");
        const live = await resolveLive(a);
        report("Resolving authorization…");
        const ownerKey = await resolveOwnerKey(a.recipient);
        report("Building burn spend…");
        const built: any = build_transfer({
          params: params(),
          annuity_coin: live.coin,
          lineage_proof: live.lineage_proof,
          asset_id: a.assetId,
          owner_synthetic_key: ownerKey,
          new_recipient: BURN_PH,
        });
        const watch = coin_id(live.coin.parent_coin_info, live.coin.puzzle_hash, BigInt(live.coin.amount));
        const summary: SpendSummaryLine[] = [
          { label: "Burning", value: `${token?.symbol ?? "CAT"} annuity`, strong: true },
          { label: "Destroyed (unrecoverable)", value: fmt(a.principalMojos) },
          { label: "Sent to", value: "0x00…00 · unspendable" },
        ];
        return { built, summary, watchCoinId: watch };
      },
    })
      .then(() => {
        toast.success("Annuity burned");
        removeAnnuity(a.streamId);
        onChange();
      })
      .catch(() => {});
  }

  function doClawback() {
    if (!a.clawbackPh) return;
    const clawbackPh = a.clawbackPh;
    // Captured from prepare() so the follow-on melt can find the issuer's
    // reclaimed cMOJO coin (XCH annuities only).
    let clawedLive: RichAnnuity | null = null;
    runSpend({
      title: `Clawback ${token?.symbol ?? "CAT"} annuity`,
      confirmLabel: "Clawback",
      prepare: async (report) => {
        report("Locating the annuity coin…");
        const live = await resolveLive(a);
        clawedLive = live;
        report("Resolving clawback authorization…");
        const { ownerKey, owner_coin } = await resolveAuthorizer(clawbackPh);
        report("Building spend bundle…");
        // ASSERT_BEFORE_SECONDS_ABSOLUTE → must be in the future vs the last block.
        const t = nowUnix() + 300;
        const built: any = build_clawback({
          params: params(),
          annuity_coin: live.coin,
          lineage_proof: live.lineage_proof,
          asset_id: a.assetId,
          owner_synthetic_key: ownerKey,
          owner_coin,
          time: t,
        });
        const watch = coin_id(live.coin.parent_coin_info, live.coin.puzzle_hash, BigInt(live.coin.amount));
        const summary: SpendSummaryLine[] = [
          { label: "Clawback", value: token?.symbol ?? "CAT" },
          { label: "Recipient keeps (accrued)", value: fmt(claimable) },
          { label: "Issuer reclaims", value: fmt(toStream), strong: true },
        ];
        return { built, summary, watchCoinId: watch };
      },
    })
      .then(async () => {
        toast.success("Clawback confirmed");
        // XCH annuity: the clawback returned the unvested portion to the issuer
        // as cMOJO (inner p2 = clawbackPh). Auto-prompt a melt → native XCH, the
        // same second leg as a claim. `toStream` is the reclaimed amount.
        if (isXch && clawedLive && toStream > 0) {
          try {
            await meltCmojoPayout(clawedLive, clawbackPh);
          } catch {
            // Cancelled or melt failed — clawback already landed; the cMOJO is
            // meltable manually later. Don't fail the clawback.
          }
        }
        removeAnnuity(a.streamId);
        onChange();
      })
      .catch(() => {});
  }

  // Generate an OPEN offer trading this annuity for XCH. The maker signs ONLY
  // the settlement terms; whoever takes it (via this dApp) names themselves the
  // new owner. No buyer is fixed — just the XCH price.
  async function doSell() {
    const price = sellPrice.trim();
    if (!price) return;
    let mojos: number;
    try {
      mojos = Number(toMojos(price, 12)); // XCH has 12 decimals
    } catch {
      toast.error("Invalid XCH amount");
      return;
    }
    if (!(mojos > 0)) {
      toast.error("Enter an XCH amount");
      return;
    }

    setSellBusy(true);
    try {
      const live = await resolveLive(a);
      const ownerKey = await resolveOwnerKey(a.recipient);
      // Requested XCH is paid to the maker's own receive address.
      const makerPh = address_to_puzzle_hash(await getAddress(request));

      const draft: any = build_open_offer({
        params: {
          recipient: live.stored.recipient,
          clawback_ph: live.stored.clawbackPh,
          end_time: live.stored.endTime,
          last_payment_time: live.stored.lastPaymentTime,
        },
        annuity_coin: live.coin,
        lineage_proof: live.lineage_proof,
        asset_id: a.assetId,
        owner_synthetic_key: ownerKey,
        maker_puzzle_hash: makerPh,
        xch_amount: mojos,
      });

      // Sage partial-signs the park spend (the owner's revealed p2 AGG_SIG).
      const resp: any = await request("chip0002_signCoinSpends", {
        coinSpends: draft.coin_spends,
        partialSign: true,
      });
      const sig: string =
        typeof resp === "string"
          ? resp
          : resp?.signature ?? resp?.aggregatedSignature ?? resp?.aggregated_signature ?? "";
      if (!sig) throw new Error("Sage did not return a signature");

      // Encode the signed maker bundle into a REAL standard offer1… string.
      const offer: string = encode_offer({
        coin_spends: draft.coin_spends,
        aggregated_signature: sig,
      });
      setOfferResult(offer);
      toast.success("Offer generated");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to generate offer");
    } finally {
      setSellBusy(false);
    }
  }

  function downloadOffer() {
    if (!offerResult) return;
    const blob = new Blob([offerResult], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `${token?.symbol ?? "annuity"}-${a.streamId.slice(2, 10)}.offer`;
    el.click();
    URL.revokeObjectURL(url);
  }

  const pct = total > 0 ? Math.round(((claimed + claimable) / total) * 100) : 0;

  return (
    <div className="panel relative overflow-hidden">
      {/* Statement header — instrument, reference, standing */}
      <div
        className="flex items-baseline justify-between gap-3 border-b px-6 pb-4 pt-5"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--fg-muted)]">
            {token?.symbol ?? "CAT"} Annuity
          </div>
          <div className="font-mono-num mt-1 text-[11px] text-[var(--fg-dim)]">
            REF {a.streamId.slice(2, 10).toUpperCase()}
          </div>
        </div>
        <div
          className="text-[11px] font-medium uppercase tracking-[0.14em]"
          style={{ color: a.clawbackPh ? "var(--warn)" : "var(--fg-muted)" }}
        >
          {a.clawbackPh ? "Clawbackable" : "Permanent"}
        </div>
      </div>

      <div className="px-6 py-5">
        {/* Primary figure */}
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--fg-muted)]">
          Claimable now
        </div>
        <div className="font-mono-num mt-2 text-[2.4rem] font-semibold leading-none tabular-nums text-[var(--fg)]">
          {fmt(claimable)}
        </div>

        {/* Vested meter */}
        <div className="mb-1.5 mt-5 flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">Vested</span>
          <span className="font-mono-num text-xs text-[var(--fg-muted)]">{pct}%</span>
        </div>
        <div className="stream-track" role="img" aria-label={`${pct}% vested`}>
          <div className="stream-claimed h-full" style={{ width: `${pctOf(claimed)}%` }} />
          <div className="stream-claimable h-full" style={{ width: `${pctOf(claimable)}%` }} />
          <div className="stream-tostream h-full" style={{ width: `${pctOf(toStream)}%` }} />
        </div>

        {/* Statement rows */}
        <dl className="mt-6 text-sm">
          <Row label="Principal" value={fmt(total)} />
          <Row label="Claimed to date" value={fmt(claimed)} />
          <Row label="Remaining" value={fmt(remaining)} />
          <Row
            label="Term ends"
            value={new Date(a.endTime * 1000).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          />
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4" style={{ borderColor: "var(--border)" }}>
        {role === "owner" && (
          <button onClick={doClaim} className="btn btn-primary btn-sm">
            Claim
          </button>
        )}
        {/* Transfer + Sell only for permanent (non-clawbackable) annuities the
            wallet owns — a clawbackable annuity isn't tradable. */}
        {role === "owner" && !a.clawbackPh && (
          <>
            <button
              onClick={() => {
                setTransferAddr("");
                setTransferOpen(true);
              }}
              className="btn btn-ghost btn-sm"
            >
              Transfer
            </button>
            <button
              onClick={() => {
                setSellPrice("");
                setOfferResult(null);
                setSellOpen(true);
              }}
              className="btn btn-ghost btn-sm"
            >
              Offer
            </button>
            <button
              onClick={() => {
                setBurnConfirm("");
                setBurnOpen(true);
              }}
              className="text-xs font-medium text-[var(--fg-dim)] transition-colors hover:text-[var(--danger)]"
            >
              Burn
            </button>
          </>
        )}
        {role === "issuer" && a.clawbackPh && (
          <button onClick={doClawback} className="btn btn-warn btn-sm">
            Clawback
          </button>
        )}
        <button
          onClick={() => { removeAnnuity(a.streamId); onChange(); }}
          className="ml-auto text-xs text-[var(--fg-dim)] transition-colors hover:text-[var(--fg-muted)]"
        >
          Forget
        </button>
      </div>

      <Modal isOpen={transferOpen} onClose={() => setTransferOpen(false)} title="Transfer annuity">
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-[var(--fg-muted)]">
            Enter the new owner&apos;s Chia address. They receive the entire remaining annuity
            (<span className="font-semibold text-[var(--fg)]">{fmt(remaining)}</span>) — this cannot be undone.
          </p>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">New owner address</span>
            <input
              value={transferAddr}
              onChange={(e) => setTransferAddr(e.target.value)}
              placeholder="xch1…"
              autoFocus
              className="field field-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && transferAddr.trim()) {
                  const dest = transferAddr.trim();
                  setTransferOpen(false);
                  doTransfer(dest);
                }
              }}
            />
          </label>
          <div className="flex gap-2">
            <button onClick={() => setTransferOpen(false)} className="btn btn-ghost btn-md flex-1">
              Cancel
            </button>
            <button
              onClick={() => {
                const dest = transferAddr.trim();
                if (!dest) return;
                setTransferOpen(false);
                doTransfer(dest);
              }}
              disabled={!transferAddr.trim()}
              className="btn btn-primary btn-md flex-1"
            >
              Continue
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={sellOpen} onClose={() => setSellOpen(false)} title="Offer annuity for XCH">
        {offerResult ? (
          <div className="flex flex-col gap-4">
            <div
              className="flex items-center gap-3 rounded-[var(--r-md)] p-3"
              style={{ background: "var(--accent-soft)", border: "1px solid var(--accent-soft-2)" }}
            >
              <span className="text-lg" aria-hidden>✓</span>
              <p className="text-sm leading-relaxed text-[var(--fg-muted)]">
                Open offer generated. Anyone who pays{" "}
                <strong className="text-[var(--fg)]">{sellPrice} XCH</strong> through the{" "}
                <em>Take offer</em> flow becomes the new owner of the remaining stream ({fmt(remaining)}).
              </p>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Offer string</span>
              <textarea
                readOnly
                value={offerResult}
                rows={6}
                onFocus={(e) => e.currentTarget.select()}
                className="field field-mono resize-none text-[11px] leading-tight"
                style={{ wordBreak: "break-all" }}
              />
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(offerResult).then(() => toast.success("Copied"));
                }}
                className="btn btn-ghost btn-md flex-1"
              >
                Copy
              </button>
              <button onClick={downloadOffer} className="btn btn-primary btn-md flex-1">
                Download
              </button>
            </div>
            <button onClick={() => setSellOpen(false)} className="text-xs text-[var(--fg-dim)] underline hover:text-[var(--fg-muted)]">
              Done
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-[var(--fg-muted)]">
              Set a price in XCH. Whoever pays it (via this dApp&apos;s Take-offer flow) becomes the new owner of the
              entire remaining stream (<span className="font-semibold text-[var(--fg)]">{fmt(remaining)}</span>). No
              buyer is fixed.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Price (XCH)</span>
              <input
                value={sellPrice}
                onChange={(e) => setSellPrice(e.target.value)}
                inputMode="decimal"
                placeholder="100"
                autoFocus
                className="field field-mono"
              />
            </label>
            <div className="flex gap-2">
              <button onClick={() => setSellOpen(false)} className="btn btn-ghost btn-md flex-1">
                Cancel
              </button>
              <button onClick={doSell} disabled={sellBusy || !sellPrice.trim()} className="btn btn-primary btn-md flex-1">
                {sellBusy ? (
                  <>
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Generating…
                  </>
                ) : (
                  "Generate offer"
                )}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={burnOpen} onClose={() => setBurnOpen(false)} title="Burn annuity">
        <div className="flex flex-col gap-4">
          <div
            className="rounded-[var(--r-md)] border p-4 text-sm leading-relaxed"
            style={{ borderColor: "rgba(217,139,134,0.3)", color: "var(--fg-muted)" }}
          >
            Burning sends the entire remaining annuity
            (<span className="font-semibold text-[var(--fg)]">{fmt(remaining)}</span>) to an unspendable address. It is
            destroyed permanently and <span className="text-[var(--danger)]">cannot be recovered</span> — there is no
            undo.
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">
              Type <span className="font-mono-num text-[var(--fg)]">BURN</span> to confirm
            </span>
            <input
              value={burnConfirm}
              onChange={(e) => setBurnConfirm(e.target.value)}
              placeholder="BURN"
              autoFocus
              className="field field-mono"
            />
          </label>
          <div className="flex gap-2">
            <button onClick={() => setBurnOpen(false)} className="btn btn-ghost btn-md flex-1">
              Cancel
            </button>
            <button
              onClick={() => {
                setBurnOpen(false);
                doBurn();
              }}
              disabled={burnConfirm.trim().toUpperCase() !== "BURN"}
              className="btn btn-warn btn-md flex-1"
            >
              Burn permanently
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
