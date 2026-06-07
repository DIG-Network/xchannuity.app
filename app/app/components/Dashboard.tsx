"use client";
import { useCallback, useEffect, useState } from "react";
import { useSage } from "../lib/walletconnect";
import { address_to_puzzle_hash } from "../lib/wasm";
import { CreatePanel } from "./CreatePanel";
import { AnnuityCard } from "./AnnuityCard";
import { TakeOffer } from "./TakeOffer";
import { loadAnnuities, type StoredAnnuity } from "../lib/storage";
import { discoverAnnuities, resolveLive } from "../lib/discovery";
import { getPublicKeys, buildKeyResolver } from "../lib/sage";

type Tab = "owned" | "issued";

export function Dashboard() {
  const { session, request } = useSage();
  const [walletPh, setWalletPh] = useState<string | null>(null);
  const [owned, setOwned] = useState<StoredAnnuity[]>([]);
  const [issued, setIssued] = useState<StoredAnnuity[]>([]);
  const [tab, setTab] = useState<Tab>("owned");
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Detect the connected wallet's annuities ON CHAIN (hint walk), classified by
  // role: OWNED (wallet is the beneficiary/recipient) vs ISSUED (wallet controls
  // the clawback authority of a clawbackable annuity). Chain truth wins.
  const refresh = useCallback(async () => {
    const local = loadAnnuities();
    if (!walletPh) {
      setOwned([]);
      setIssued([]);
      return;
    }
    setScanning(true);
    try {
      const keys = await getPublicKeys(request);
      const resolver = buildKeyResolver(keys);
      const owns = (ph?: string | null) => !!ph && !!resolver(ph);

      // OWNED — chain discovery (recipient hint) merged with the local cache.
      const chain = await discoverAnnuities(walletPh);
      const keyOf = (x: StoredAnnuity) =>
        `${x.assetId.toLowerCase()}:${x.endTime}:${x.recipient.toLowerCase()}`;
      const localOwned = local.filter((a) => owns(a.recipient));
      const localByKey = new Map(localOwned.map((x) => [keyOf(x), x]));
      const merged = new Map<string, StoredAnnuity>();
      for (const x of localOwned) merged.set(keyOf(x), x);
      for (const c of chain) {
        const l = localByKey.get(keyOf(c));
        merged.set(
          keyOf(c),
          l ? { ...c, totalMojos: l.totalMojos, startTime: l.startTime, streamId: l.streamId } : c,
        );
      }
      setOwned([...merged.values()]);

      // ISSUED — local clawbackable annuities whose clawback authority we hold.
      // (Coins are hinted to the beneficiary, so these come from the local cache;
      // each is refreshed live against chain for current remaining/last.)
      const issuedLocal = local.filter((a) => a.clawbackPh && owns(a.clawbackPh));
      const refreshed = await Promise.all(
        issuedLocal.map(async (a) => {
          try {
            const live = await resolveLive(a);
            return {
              ...a,
              recipient: live.stored.recipient,
              principalMojos: live.stored.principalMojos,
              lastPaymentTime: live.stored.lastPaymentTime,
            };
          } catch {
            return a;
          }
        }),
      );
      setIssued(refreshed);
    } catch {
      setOwned(local.filter((a) => a.recipient.toLowerCase() === walletPh));
      setIssued([]);
    } finally {
      setScanning(false);
    }
  }, [walletPh, request]);

  // Resolve the connected wallet's puzzle hash; re-runs when the wallet changes.
  useEffect(() => {
    if (!session) {
      setWalletPh(null);
      return;
    }
    let cancelled = false;
    request<{ address: string }>("chia_getAddress", {})
      .then((r) => {
        if (cancelled) return;
        try {
          setWalletPh(address_to_puzzle_hash((r as any)?.address ?? r).toLowerCase());
        } catch {
          setWalletPh(null);
        }
      })
      .catch(() => {
        if (!cancelled) setWalletPh(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, request]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const list = tab === "owned" ? owned : issued;

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight">Your annuities</h2>
          <p className="mt-1 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            {scanning ? (
              <>
                <span className="h-1.5 w-1.5 animate-ping rounded-full" style={{ background: "var(--accent)" }} />
                scanning chain…
              </>
            ) : (
              <>
                <span className="font-mono-num font-semibold text-[var(--fg)]">{owned.length}</span> owned
                <span className="text-[var(--fg-dim)]">·</span>
                <span className="font-mono-num font-semibold text-[var(--fg)]">{issued.length}</span> issued
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => refresh()}
            disabled={scanning}
            className="btn btn-ghost btn-sm"
            aria-label="Refresh annuities"
          >
            <span className={scanning ? "inline-block animate-spin" : "inline-block"} aria-hidden>
              ↻
            </span>
            {scanning ? "Scanning…" : "Refresh"}
          </button>
          <TakeOffer onTaken={refresh} />
          <button onClick={() => setCreating((v) => !v)} className="btn btn-primary btn-sm">
            {creating ? "Close" : "+ New annuity"}
          </button>
        </div>
      </div>

      {creating && (
        <div className="scale-in">
          <CreatePanel onDone={() => { setCreating(false); refresh(); }} />
        </div>
      )}

      {/* Role tabs */}
      <div className="flex items-center justify-between gap-3">
        <div className="seg" role="tablist" aria-label="Annuity role">
          {(
            [
              ["owned", "Owned", owned.length],
              ["issued", "Issued", issued.length],
            ] as [Tab, string, number][]
          ).map(([t, label, count]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className="seg-item"
              data-active={tab === t}
            >
              {label}
              <span className="ml-1.5 font-mono-num opacity-70">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {scanning && list.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="panel p-5">
              <div className="mb-4 flex items-center justify-between">
                <div className="skeleton h-4 w-28" />
                <div className="skeleton h-4 w-20 rounded-full" />
              </div>
              <div className="skeleton mb-2 h-9 w-40" />
              <div className="skeleton mb-4 h-3 w-32" />
              <div className="skeleton mb-4 h-3 w-full" />
              <div className="flex gap-2">
                <div className="skeleton h-8 w-20 rounded-full" />
                <div className="skeleton h-8 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 p-12 text-center">
          <span
            className="inline-flex h-14 w-14 items-center justify-center rounded-2xl text-2xl"
            style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-soft-2)" }}
            aria-hidden
          >
            {tab === "owned" ? "🌱" : "↩"}
          </span>
          <p className="max-w-sm text-sm leading-relaxed text-[var(--fg-muted)]">
            {tab === "owned" ? (
              <>
                No annuities you own yet. Click <strong className="text-[var(--fg)]">+ New annuity</strong> to create
                one, or <strong className="text-[var(--fg)]">Take offer</strong> to buy one.
              </>
            ) : (
              <>
                No annuities you&apos;ve issued. Create a non-permanent (clawbackable) annuity and it appears here,
                where you can clawback the unvested remainder.
              </>
            )}
          </p>
          {tab === "owned" && (
            <button onClick={() => setCreating(true)} className="btn btn-primary btn-sm mt-1">
              + Create your first annuity
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((a, i) => (
            <div key={`${a.streamId}:${tab}`} className="rise-in" style={{ animationDelay: `${Math.min(i, 6) * 0.05}s` }}>
              <AnnuityCard a={a} role={tab === "issued" ? "issuer" : "owner"} onChange={refresh} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
