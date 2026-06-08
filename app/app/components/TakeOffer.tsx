"use client";
import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { useSage } from "../lib/walletconnect";
import { useSpendConfirm, type SpendSummaryLine } from "./SpendConfirm";
import Modal from "./Modal";
import { build_take_from_offer, inspect_offer, coin_id, address_to_puzzle_hash } from "../lib/wasm";
import { getAddress, getPublicKeys, getAssetCoins, buildKeyResolver, normalizeCoin } from "../lib/sage";
import { tokenByAssetId } from "../lib/tokens";
import { fromMojos, mojosToXch, humanCountdown, nowUnix } from "../lib/format";

interface Inspected {
  asset_id: string;
  amount: number;
  end_time: number;
  last_payment_time: number;
  clawback_ph: string | null;
  maker_puzzle_hash: string;
  xch_amount: number;
}

// Take a standard annuity `offer1…`: paste the offer, SEE exactly what it trades
// (decoded from the offer itself), pay its XCH price, and become the new owner.
export function TakeOffer({ onTaken }: { onTaken: () => void }) {
  const { request } = useSage();
  const { runSpend } = useSpendConfirm();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(file?: File | null) {
    if (!file) return;
    try {
      parse((await file.text()).trim());
    } catch {
      setErr("Could not read that file");
    }
  }

  function parse(s: string) {
    setText(s);
    setErr(null);
    setInspected(null);
    const t = s.trim();
    if (!t) return;
    if (!t.startsWith("offer1")) {
      setErr("Not a standard offer (expected offer1…)");
      return;
    }
    try {
      setInspected(inspect_offer(t) as Inspected);
    } catch (e: any) {
      setErr(e?.message ?? "Could not read this offer");
    }
  }

  function reset() {
    setText("");
    setErr(null);
    setInspected(null);
  }

  const token = inspected ? tokenByAssetId(inspected.asset_id) : undefined;
  const isCmojo = token?.symbol === "cMOJO";
  const fmtAnnuity = (m: number) =>
    isCmojo ? `${mojosToXch(m)} XCH-equiv` : `${fromMojos(m, token?.decimals ?? 3)} ${token?.symbol ?? "CAT"}`;

  function doTake() {
    const offer = text.trim();
    const info = inspected;
    if (!offer.startsWith("offer1") || !info) {
      toast.error("Paste a valid offer1… string");
      return;
    }
    runSpend({
      title: "Take annuity offer",
      confirmLabel: `Pay ${mojosToXch(info.xch_amount)} XCH & take`,
      prepare: async (report) => {
        report("Resolving your address…");
        const takerRecipient = address_to_puzzle_hash(await getAddress(request));

        report("Selecting XCH to pay…");
        const keys = await getPublicKeys(request);
        const resolver = buildKeyResolver(keys);
        const xch = await getAssetCoins(request, null, null);
        const cand = xch
          .map((r) => ({ coin: normalizeCoin(r), key: resolver(normalizeCoin(r).puzzle_hash) }))
          .filter((c) => c.key && BigInt(c.coin.amount) >= BigInt(info.xch_amount))
          // smallest coin that still covers the price (less change churn)
          .sort((a, b) => (BigInt(a.coin.amount) > BigInt(b.coin.amount) ? 1 : -1));
        if (cand.length === 0)
          throw new Error(`Need a single spendable XCH coin ≥ ${mojosToXch(info.xch_amount)} XCH`);
        const taker = cand[0];

        report("Building spend bundle…");
        const built: any = build_take_from_offer({
          offer,
          taker_recipient: takerRecipient,
          taker_xch_coin: taker.coin,
          taker_synthetic_key: taker.key,
        });

        // Watch the taker's XCH coin (spent on confirmation) → confirmation spinner.
        const watch = coin_id(
          taker.coin.parent_coin_info,
          taker.coin.puzzle_hash,
          BigInt(taker.coin.amount),
        );
        const summary: SpendSummaryLine[] = [
          { label: "You receive", value: `${fmtAnnuity(info.amount)} annuity`, strong: true },
          { label: "Vesting ends", value: humanCountdown(info.end_time, nowUnix()) },
          { label: "You pay", value: `${mojosToXch(info.xch_amount)} XCH` },
        ];
        return { built, summary, watchCoinId: watch };
      },
    })
      .then(() => {
        toast.success("Offer taken — you now own the annuity");
        setOpen(false);
        reset();
        onTaken();
      })
      .catch(() => {});
  }

  return (
    <>
      <button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="btn btn-ghost btn-sm"
      >
        Take offer
      </button>

      <Modal isOpen={open} onClose={() => setOpen(false)} title="Take an annuity offer">
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-[var(--fg-muted)]">
            Provide a standard annuity offer (<span className="font-mono-num">offer1…</span>) — drop a file, browse, or
            paste it. You&apos;ll see exactly what it trades before paying.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              readFile(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
            className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[var(--r-md)] border border-dashed px-4 py-8 text-center transition-colors"
            style={{
              borderColor: drag ? "var(--accent)" : "var(--border-strong)",
              background: drag ? "var(--accent-soft)" : "transparent",
            }}
          >
            <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--fg-muted)]">
              Drop an offer file
            </span>
            <span className="text-xs text-[var(--fg-dim)]">
              or <span className="text-[var(--fg-muted)] underline">browse</span> · .offer / .txt
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".offer,.txt,text/plain"
              className="hidden"
              onChange={(e) => readFile(e.target.files?.[0])}
            />
          </div>

          <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">
            <span className="h-px flex-1" style={{ background: "var(--border)" }} />
            or paste
            <span className="h-px flex-1" style={{ background: "var(--border)" }} />
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Offer string</span>
            <textarea
              value={text}
              onChange={(e) => parse(e.target.value)}
              rows={5}
              placeholder="offer1…"
              autoFocus
              className={`field field-mono resize-none text-[11px] leading-tight ${err ? "!border-[var(--danger)]" : ""}`}
              style={{ wordBreak: "break-all" }}
            />
          </label>
          {err && (
            <p className="text-xs text-[var(--danger)]">{err}</p>
          )}

          {inspected && (
            <div
              className="scale-in rounded-[var(--r-md)] p-4 text-sm"
              style={{ border: "1px solid var(--accent-soft-2)", background: "var(--accent-soft)" }}
            >
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[var(--fg-muted)]">You receive</span>
                <span className="font-mono-num font-semibold" style={{ color: "var(--accent-bright)" }}>
                  {fmtAnnuity(inspected.amount)} annuity
                </span>
              </div>
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[var(--fg-muted)]">Vesting ends</span>
                <span className="font-mono-num">{humanCountdown(inspected.end_time, nowUnix())}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[var(--fg-muted)]">You pay</span>
                <span className="font-mono-num font-semibold">{mojosToXch(inspected.xch_amount)} XCH</span>
              </div>
              {inspected.clawback_ph && (
                <p className="mt-3 border-t pt-2.5 text-xs" style={{ borderColor: "rgba(216,166,74,0.25)", color: "var(--warn)" }}>
                  Clawbackable — the issuer can still terminate this annuity.
                </p>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={() => setOpen(false)} className="btn btn-ghost btn-md flex-1">
              Cancel
            </button>
            <button onClick={doTake} disabled={!inspected || !!err} className="btn btn-primary btn-md flex-1">
              Review &amp; take
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
