"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useSage } from "../lib/walletconnect";
import { address_to_puzzle_hash } from "../lib/wasm";
import { CreatePanel } from "./CreatePanel";
import { AnnuityCard } from "./AnnuityCard";
import { RecoverCmojo } from "./RecoverCmojo";
import { TakeOffer } from "./TakeOffer";
import Diamond from "./Diamond";
import { loadAnnuities, saveAnnuity, type StoredAnnuity } from "../lib/storage";
import { parseBackup } from "../lib/backup";
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
  const fileRef = useRef<HTMLInputElement>(null);

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

  // Import a `.xchannuity` backup: validate, persist to the local cache, then
  // re-scan so chain truth fills in the live coin/role. Recovers an annuity the
  // browser cache lost, or one created in another wallet/app.
  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file later
      if (!file) return;
      try {
        const imported = parseBackup(await file.text());
        saveAnnuity(imported);
        toast.success("Annuity imported");
        refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't import that file");
      }
    },
    [refresh],
  );

  const list = tab === "owned" ? owned : issued;

  return (
    <div className="flex flex-col gap-7">
      <RecoverCmojo onChange={refresh} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-serif text-[1.7rem] font-medium tracking-tight">Your annuities</h2>
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
            <svg
              className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
            </svg>
            {scanning ? "Scanning…" : "Refresh"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xchannuity,application/json"
            className="hidden"
            onChange={onImportFile}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="btn btn-ghost btn-sm"
            title="Import a .xchannuity backup file"
          >
            Import
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
          <Diamond className="mb-1 h-28 w-28" />
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
