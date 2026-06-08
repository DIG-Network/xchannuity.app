"use client";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useSage } from "../lib/walletconnect";
import { useSpendConfirm, type SpendSummaryLine } from "./SpendConfirm";
import { build_create_annuity, address_to_puzzle_hash, standard_puzzle_hash } from "../lib/wasm";
import {
  getPublicKeys,
  getAssetCoins,
  sumCoinAmounts,
  normalizeCoin,
  normalizeLineageProof,
  buildCatKeyResolver,
  buildKeyResolver,
  extractCoinName,
} from "../lib/sage";
import { SUPPORTED_TOKENS } from "../lib/tokens";
import { fromMojos, toMojos, mojosToXch, nowUnix, with0x } from "../lib/format";
import { saveAnnuity } from "../lib/storage";

const PRESETS = [1, 3, 5, 10];
const UNIT_SECONDS: Record<string, number> = { days: 86400, months: 2_629_800, years: 31_536_000 };

export function CreatePanel({ onDone }: { onDone: () => void }) {
  const { request } = useSage();
  const { runSpend } = useSpendConfirm();
  const [tokenIdx, setTokenIdx] = useState(0); // -1 = custom asset id
  const [customAsset, setCustomAsset] = useState("");
  const [customSymbol, setCustomSymbol] = useState("");
  const [customDecimals, setCustomDecimals] = useState(3);
  const [amount, setAmount] = useState("100");
  const [beneficiary, setBeneficiary] = useState<"self" | "other">("self");
  const [address, setAddress] = useState("");
  const [years, setYears] = useState(3);
  const [customMode, setCustomMode] = useState(false);
  const [customValue, setCustomValue] = useState("18");
  const [customUnit, setCustomUnit] = useState<"days" | "months" | "years">("months");
  const [permanent, setPermanent] = useState(true);
  const [networkFeeXch, setNetworkFeeXch] = useState("0.0001");
  const [busy, setBusy] = useState(false);

  const token = useMemo(
    () =>
      tokenIdx >= 0
        ? SUPPORTED_TOKENS[tokenIdx]
        : {
            symbol: customSymbol || "CAT",
            name: "Custom CAT",
            assetId: customAsset.trim() ? with0x(customAsset.trim()) : "",
            decimals: customDecimals,
          },
    [tokenIdx, customAsset, customSymbol, customDecimals],
  );
  const feeBps = 50; // mirrors on-chain PROTOCOL_FEE_BPS (0.5%)
  const isXch = !!token.isXch; // XCH: native balance + wrap→cMOJO on create

  const termSeconds = customMode
    ? Math.max(1, Math.floor(parseFloat(customValue || "0") * UNIT_SECONDS[customUnit]))
    : years * UNIT_SECONDS.years;
  const termLabel = customMode ? `${customValue} ${customUnit}` : `${years} year${years === 1 ? "" : "s"}`;

  // Wallet balance of the selected asset.
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    (async () => {
      try {
        if (isXch) {
          // native XCH balance (wrapped to cMOJO at spend time)
          const coins = await getAssetCoins(request, null, null);
          if (!cancelled) setBalance(sumCoinAmounts(coins));
          return;
        }
        if (!token.assetId) {
          if (!cancelled) setBalance(0n);
          return;
        }
        const coins = await getAssetCoins(request, "cat", token.assetId);
        if (!cancelled) setBalance(sumCoinAmounts(coins));
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.assetId, isXch, request]);

  const balanceLabel =
    balance === null
      ? "…"
      : isXch
        ? `${mojosToXch(balance)} XCH`
        : `${fromMojos(balance, token.decimals)} ${token.symbol}`;

  // Plain (comma-free) decimal string for one-click "use full balance".
  const fillValue =
    balance == null || balance <= 0n
      ? ""
      : isXch
        ? mojosToXch(balance)
        : fromMojos(balance, token.decimals);

  const preview = useMemo(() => {
    const amt = parseFloat(amount || "0");
    const fee = (amt * feeBps) / 10_000;
    const net = amt - fee;
    const perDay = termSeconds > 0 ? (net * 86400) / termSeconds : 0;
    return { fee, net, perDay };
  }, [amount, termSeconds, feeBps]);

  async function create() {
    // XCH create wraps XCH→cMOJO at spend time via cmojo-core. That spend path
    // is being wired up; until then, guard so it doesn't fall through to the
    // (wrong) cMOJO-CAT-coin path and fail confusingly.
    if (isXch) {
      toast.error("XCH annuities are being wired up (XCH→cMOJO wrap). Coming shortly.");
      return;
    }
    setBusy(true);
    const startTime = nowUnix();
    const endTime = startTime + termSeconds;
    const principal = Number(toMojos(amount, token.decimals));
    const feeMojos = Math.floor((principal * feeBps) / 10_000);
    let recipientHolder = "";
    let clawbackHolder: string | null = null;
    let streamIdHolder = "";

    try {
      await runSpend({
        title: `Create ${amount} ${token.symbol} annuity`,
        confirmLabel: "Create annuity",
        prepare: async (report) => {
          report("Resolving wallet keys & address…");
          const keys = await getPublicKeys(request);
          // The connected wallet is the ISSUER. Clawback authority is the issuer
          // (so the issuer — not the beneficiary — can reclaim the unvested rest).
          const creatorResp = await request<{ address: string }>("chia_getAddress", {});
          const creatorPh = address_to_puzzle_hash((creatorResp as any).address ?? (creatorResp as any));
          const recipient = beneficiary === "self" ? creatorPh : address_to_puzzle_hash(address.trim());
          recipientHolder = recipient;
          clawbackHolder = permanent ? null : creatorPh;

          report(`Fetching ${token.symbol} coins…`);
          const raw = await getAssetCoins(request, "cat", token.assetId);
          if (raw.length === 0) throw new Error(`No ${token.symbol} coins in this wallet`);

          report("Selecting coins…");
          // Resolve each coin's controlling key. Funding can span MULTIPLE keys
          // (addresses), so we don't restrict the selection to a single key — we
          // just gather enough coins (across any keys we control) to cover the
          // principal. Each coin carries its OWN key + p2 hash to the builder.
          const keyOf = buildCatKeyResolver(keys, token.assetId);
          const withKey = raw
            .map((r) => {
              const coin = normalizeCoin(r);
              const key = keyOf(coin.puzzle_hash);
              return {
                raw: r,
                coin,
                lineage: normalizeLineageProof((r as any).lineageProof ?? (r as any).lineage_proof),
                key,
              };
            })
            .filter((n) => n.key)
            // largest first → fewest inputs to cover the principal
            .sort((a, b) => (BigInt(b.coin.amount) > BigInt(a.coin.amount) ? 1 : -1));
          if (withKey.length === 0) throw new Error("Could not match a wallet key to your coins");

          const available = withKey.reduce((a, n) => a + BigInt(n.coin.amount), 0n);
          if (available < BigInt(principal)) {
            throw new Error(
              `Insufficient ${token.symbol} for ${amount} (have ${fromMojos(available, token.decimals)})`,
            );
          }

          // Greedily select coins (regardless of which key controls them).
          const selected: typeof withKey = [];
          let total = 0n;
          for (const n of withKey) {
            if (total >= BigInt(principal)) break;
            selected.push(n);
            total += BigInt(n.coin.amount);
          }

          const funding = selected.map((n) => ({
            coin: n.coin,
            lineage_proof: n.lineage,
            p2_puzzle_hash: standard_puzzle_hash(n.key!),
            synthetic_key: n.key!,
          }));

          // Optional XCH network (farming) fee from a funder coin.
          const feeMojosXch = Number(toMojos(networkFeeXch || "0", 12));
          let xch_fee_coin: any;
          let xch_fee_key: string | undefined;
          if (feeMojosXch > 0) {
            report("Selecting XCH for the network fee…");
            const xch = await getAssetCoins(request, null, null);
            const xchKeyOf = buildKeyResolver(keys);
            const cand = xch
              .map((r) => ({ coin: normalizeCoin(r), key: xchKeyOf(normalizeCoin(r).puzzle_hash) }))
              .filter((c) => c.key && BigInt(c.coin.amount) > BigInt(feeMojosXch));
            if (cand.length === 0) throw new Error("No spendable XCH coin to pay the network fee");
            xch_fee_coin = cand[0].coin;
            xch_fee_key = cand[0].key!;
          }

          report("Building spend bundle…");
          const built: any = build_create_annuity({
            asset_id: token.assetId,
            funding,
            recipient,
            clawback_ph: clawbackHolder,
            end_time: endTime,
            start_time: startTime,
            principal,
            network_fee_mojos: feeMojosXch,
            xch_fee_coin,
            xch_fee_key,
          });
          streamIdHolder = built.stream_id;

          const summary: SpendSummaryLine[] = [
            { label: "Token", value: token.symbol },
            { label: "Amount", value: `${amount} ${token.symbol}` },
            { label: "Protocol fee", value: `${fromMojos(feeMojos, token.decimals)} ${token.symbol}` },
            { label: "Streamed", value: `${fromMojos(principal - feeMojos, token.decimals)} ${token.symbol}`, strong: true },
            { label: "Term", value: termLabel },
            { label: "Beneficiary", value: beneficiary === "self" ? "Myself" : address.trim() },
            { label: "Network fee", value: `${networkFeeXch || "0"} XCH` },
          ];

          return { built, summary, watchCoinId: extractCoinName(selected[0].raw) };
        },
      });

      saveAnnuity({
        streamId: streamIdHolder,
        assetId: token.assetId,
        recipient: recipientHolder,
        clawbackPh: clawbackHolder,
        startTime,
        endTime,
        lastPaymentTime: startTime,
        principalMojos: principal - feeMojos,
        totalMojos: principal - feeMojos,
        createdAt: startTime,
      });
      onDone();
    } catch {
      // SpendConfirm already surfaced the error
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel p-6">
      <div className="mb-5 flex items-center gap-2.5">
        <span
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-soft-2)" }}
          aria-hidden
        >
          <svg viewBox="0 0 32 32" className="h-4 w-4">
            <path d="M16 4 26 9.5v13L16 28 6 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M11 20.5c2.5-9 7.5-9 10 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
          </svg>
        </span>
        <h3 className="font-serif text-2xl font-medium tracking-tight">Create an annuity</h3>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* Left column — token, amount, beneficiary */}
        <div className="flex flex-col gap-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Token</span>
            <select
              value={tokenIdx}
              onChange={(e) => setTokenIdx(Number(e.target.value))}
              className="field"
            >
              {SUPPORTED_TOKENS.map((t, i) => (
                <option key={t.assetId} value={i} className="bg-[var(--panel)]">
                  {t.symbol} — {t.name}
                </option>
              ))}
              <option value={-1} className="bg-[var(--panel)]">Custom asset id…</option>
            </select>
          </label>

          {tokenIdx === -1 && (
            <div className="flex flex-col gap-2">
              <input
                value={customAsset}
                onChange={(e) => setCustomAsset(e.target.value)}
                placeholder="CAT asset id (0x… 64 hex)"
                className="field field-mono text-xs"
              />
              <div className="flex gap-2">
                <input
                  value={customSymbol}
                  onChange={(e) => setCustomSymbol(e.target.value)}
                  placeholder="symbol (optional)"
                  className="field flex-1"
                />
                <input
                  type="number"
                  min={0}
                  max={12}
                  value={customDecimals}
                  onChange={(e) => setCustomDecimals(Number(e.target.value))}
                  title="decimals"
                  className="field w-20"
                />
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--fg-muted)]">Amount ({token.symbol})</span>
              {balance === null ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-[var(--fg-dim)]">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]" />
                  bal
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => fillValue && setAmount(fillValue)}
                  disabled={!fillValue}
                  title="Use full balance"
                  className="text-xs text-[var(--fg-dim)] transition-colors hover:text-[var(--fg-muted)] disabled:cursor-default disabled:hover:text-[var(--fg-dim)]"
                >
                  bal <span className="font-mono-num font-medium text-[var(--accent)]">{balanceLabel}</span>
                </button>
              )}
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="field field-mono"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Beneficiary</span>
            <div className="flex gap-2">
              <button
                onClick={() => setBeneficiary("self")}
                className={`btn btn-sm flex-1 ${beneficiary === "self" ? "btn-primary" : "btn-ghost"}`}
              >
                Myself
              </button>
              <button
                onClick={() => setBeneficiary("other")}
                className={`btn btn-sm flex-1 ${beneficiary === "other" ? "btn-primary" : "btn-ghost"}`}
              >
                Another address
              </button>
            </div>
            {beneficiary === "other" && (
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="xch1…"
                className="field field-mono mt-2"
              />
            )}
          </div>
        </div>

        {/* Right column — term, options, fee */}
        <div className="flex flex-col gap-4">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">Term</span>
            <div className="flex flex-wrap items-center gap-2">
              {PRESETS.map((y) => (
                <button
                  key={y}
                  onClick={() => {
                    setCustomMode(false);
                    setYears(y);
                  }}
                  className={`btn btn-sm ${!customMode && years === y ? "btn-primary" : "btn-ghost"}`}
                >
                  {y} yr
                </button>
              ))}
              <button
                onClick={() => setCustomMode(true)}
                className={`btn btn-sm ${customMode ? "btn-primary" : "btn-ghost"}`}
              >
                Custom
              </button>
            </div>
            {customMode && (
              <div className="mt-2 flex gap-2">
                <input
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  inputMode="decimal"
                  className="field field-mono w-24"
                />
                <select
                  value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value as any)}
                  className="field"
                >
                  <option value="days" className="bg-[var(--panel)]">days</option>
                  <option value="months" className="bg-[var(--panel)]">months</option>
                  <option value="years" className="bg-[var(--panel)]">years</option>
                </select>
              </div>
            )}
          </div>

          <label
            className="flex cursor-pointer items-start gap-3 rounded-[var(--r-md)] border p-3 transition-colors"
            style={{
              borderColor: permanent ? "var(--accent-soft-2)" : "var(--border)",
              background: permanent ? "var(--accent-soft)" : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={permanent}
              onChange={(e) => setPermanent(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              <span className="text-sm font-medium">Permanent (no clawback)</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-[var(--fg-muted)]">
                {permanent
                  ? "The beneficiary fully owns it: claimable, transferable, and sellable."
                  : "You (the issuer) can clawback the unvested remainder anytime. Clawbackable annuities can't be transferred or sold."}
              </span>
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-[var(--fg-muted)]">
              Network fee (XCH, for mempool inclusion)
            </span>
            <input
              value={networkFeeXch}
              onChange={(e) => setNetworkFeeXch(e.target.value)}
              inputMode="decimal"
              className="field field-mono"
            />
          </label>
        </div>
      </div>

      {/* Preview */}
      <div
        className="mt-5 rounded-[var(--r-md)] p-4 text-xs"
        style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.2)" }}
      >
        <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--fg-dim)]">Preview</div>
        <div className="flex justify-between py-0.5">
          <span className="text-[var(--fg-muted)]">Protocol fee ({(feeBps / 100).toFixed(2)}%)</span>
          <span className="font-mono-num">{preview.fee.toLocaleString()} {token.symbol}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-[var(--fg-muted)]">Streamed principal</span>
          <span className="font-mono-num font-semibold text-[var(--accent)]">{preview.net.toLocaleString()} {token.symbol}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-[var(--fg-muted)]">Vesting rate</span>
          <span className="font-mono-num">{preview.perDay.toFixed(4)} {token.symbol}/day</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span className="text-[var(--fg-muted)]">Term</span>
          <span className="font-mono-num">{termLabel}</span>
        </div>
      </div>

      <button onClick={create} disabled={busy} className="btn btn-primary btn-md mt-5 w-full">
        {busy ? (
          <>
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Working…
          </>
        ) : (
          "Create annuity"
        )}
      </button>
    </div>
  );
}
