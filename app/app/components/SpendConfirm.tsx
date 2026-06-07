"use client";

// One modal for the whole spend lifecycle (ported from the cXCH reference):
//   1. PREPARING — build runs inside the modal with a live step list.
//   2. CONFIRM   — human-readable summary; user authorizes.
//   3. SIGNING   — Sage signs, bundle aggregated + pushed to coinset.
//   4. WAITING   — poll coinset.org until the watched input coin is spent.
//   5. DONE / ERROR.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useSage } from "../lib/walletconnect";
import { signAndBroadcast, type BuiltBundle } from "../lib/flow";
import { waitForConfirmation, type ConfirmProgress } from "../lib/coinset";

export interface SpendSummaryLine {
  label: string;
  value: string;
  strong?: boolean;
}
export interface PreparedSpend {
  built: BuiltBundle;
  summary: SpendSummaryLine[];
  watchCoinId?: string;
}
export interface SpendRequest {
  title: string;
  prepare: (report: (step: string) => void) => Promise<PreparedSpend>;
  confirmLabel?: string;
}

type Phase = "idle" | "preparing" | "confirm" | "signing" | "waiting" | "done" | "error";

interface SpendCtx {
  runSpend: (req: SpendRequest) => Promise<ConfirmProgress>;
  active: boolean;
}
const Ctx = createContext<SpendCtx | null>(null);
export function useSpendConfirm(): SpendCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSpendConfirm must be used within SpendConfirmProvider");
  return c;
}

interface StepState {
  label: string;
  done: boolean;
}
function Spinner() {
  return (
    <div
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent"
      role="status"
      aria-label="Working"
    />
  );
}

export function SpendConfirmProvider({ children }: { children: React.ReactNode }) {
  const { request } = useSage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [req, setReq] = useState<SpendRequest | null>(null);
  const [progress, setProgress] = useState<ConfirmProgress | null>(null);
  const [errMsg, setErrMsg] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const [stepElapsed, setStepElapsed] = useState(0);
  const preparedRef = useRef<PreparedSpend | null>(null);
  const prepareStartedRef = useRef(false);
  const resolveRef = useRef<((p: ConfirmProgress) => void) | null>(null);
  const rejectRef = useRef<((e: Error) => void) | null>(null);

  const settleReject = (e: Error) => {
    rejectRef.current?.(e);
    resolveRef.current = null;
    rejectRef.current = null;
  };

  const close = useCallback(() => {
    if (rejectRef.current) settleReject(new Error("Cancelled by user"));
    setPhase("idle");
    setReq(null);
    setProgress(null);
    setErrMsg("");
    setSteps([]);
    preparedRef.current = null;
    prepareStartedRef.current = false;
  }, []);

  const runSpend = useCallback((r: SpendRequest) => {
    setReq(r);
    setProgress(null);
    setErrMsg("");
    setSteps([]);
    preparedRef.current = null;
    prepareStartedRef.current = false;
    setPhase("preparing");
    return new Promise<ConfirmProgress>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;
    });
  }, []);

  useEffect(() => {
    if (phase !== "preparing" || !req || prepareStartedRef.current) return;
    prepareStartedRef.current = true;
    const report = (label: string) => {
      setSteps((prev) => [...prev.map((s) => ({ ...s, done: true })), { label, done: false }]);
    };
    (async () => {
      try {
        preparedRef.current = await req.prepare(report);
        setSteps((prev) => prev.map((s) => ({ ...s, done: true })));
        setPhase("confirm");
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setErrMsg(err.message);
        setPhase("error");
        settleReject(err);
      }
    })();
  }, [phase, req]);

  useEffect(() => {
    if (phase !== "preparing") {
      setStepElapsed(0);
      return;
    }
    setStepElapsed(0);
    const t0 = Date.now();
    const id = setInterval(() => setStepElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [phase, steps.length]);

  const onConfirm = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!prepared) return;
    try {
      setPhase("signing");
      await signAndBroadcast(request, prepared.built);
      let final: ConfirmProgress = { status: "confirmed", confirmations: 0 };
      if (prepared.watchCoinId) {
        setPhase("waiting");
        final = await waitForConfirmation(prepared.watchCoinId, {
          confirmations: 1,
          onProgress: setProgress,
        });
      }
      setProgress(final);
      setPhase("done");
      resolveRef.current?.(final);
      resolveRef.current = null;
      rejectRef.current = null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setErrMsg(err.message);
      setPhase("error");
      settleReject(err);
    }
  }, [request]);

  const summary = preparedRef.current?.summary ?? [];

  return (
    <Ctx.Provider value={{ runSpend, active: phase !== "idle" }}>
      {children}
      {phase !== "idle" && req && (
        <div className="fade-in fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md">
          <div className="scale-in panel w-full max-w-md space-y-4 p-6" style={{ boxShadow: "var(--shadow-pop)" }}>
            <h2 className="font-display text-lg font-bold tracking-tight">{req.title}</h2>

            {phase === "preparing" && (
              <div className="space-y-4">
                <p className="text-xs leading-relaxed text-[var(--fg-muted)]">
                  Preparing your spend — fetching wallet keys and coins, then assembling the bundle.
                </p>
                <ul className="space-y-2">
                  {steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-2.5 text-sm">
                      {s.done ? (
                        <span
                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]"
                          style={{ background: "var(--accent-soft-2)", color: "var(--accent-bright)" }}
                        >
                          ✓
                        </span>
                      ) : (
                        <Spinner />
                      )}
                      <span className={s.done ? "text-[var(--fg-muted)]" : "font-medium"}>{s.label}</span>
                      {!s.done && (
                        <span className="font-mono-num ml-auto text-xs tabular-nums text-[var(--fg-dim)]">{stepElapsed}s</span>
                      )}
                    </li>
                  ))}
                  {steps.length === 0 && (
                    <li className="flex items-center gap-2.5 text-sm">
                      <Spinner />
                      <span className="font-medium">Starting…</span>
                    </li>
                  )}
                </ul>
                <button className="btn btn-ghost btn-md w-full" onClick={close}>
                  Cancel
                </button>
              </div>
            )}

            {phase !== "preparing" && summary.length > 0 && (
              <dl
                className="space-y-2 rounded-[var(--r-md)] p-4"
                style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.2)" }}
              >
                {summary.map((l, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 text-sm">
                    <dt className="text-[var(--fg-muted)]">{l.label}</dt>
                    <dd className={`font-mono-num break-all text-right ${l.strong ? "font-semibold text-[var(--accent-bright)]" : ""}`}>
                      {l.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {phase === "confirm" && (
              <>
                <p className="text-xs leading-relaxed text-[var(--fg-muted)]">
                  Sage will ask you to sign the coin spends. After broadcast we wait for on-chain confirmation via
                  coinset.org.
                </p>
                <div className="flex gap-2">
                  <button className="btn btn-ghost btn-md flex-1" onClick={close}>
                    Cancel
                  </button>
                  <button className="btn btn-primary btn-md flex-1" onClick={onConfirm}>
                    {req.confirmLabel ?? "Confirm & sign"}
                  </button>
                </div>
              </>
            )}

            {phase === "signing" && (
              <div
                className="flex items-center gap-3 rounded-[var(--r-md)] p-4 text-sm text-[var(--fg-muted)]"
                style={{ border: "1px solid var(--accent-soft-2)", background: "var(--accent-soft)" }}
              >
                <Spinner />
                <span>
                  <span className="font-medium text-[var(--fg)]">Sign in Sage</span> — then we broadcast to mainnet…
                </span>
              </div>
            )}

            {phase === "waiting" && (
              <div
                className="flex items-center gap-3 rounded-[var(--r-md)] p-4 text-sm text-[var(--fg-muted)]"
                style={{ border: "1px solid var(--accent-soft-2)", background: "var(--accent-soft)" }}
              >
                <Spinner />
                <span>
                  <span className="font-medium text-[var(--fg)]">Confirming on-chain</span> — waiting via coinset.org…
                </span>
              </div>
            )}

            {phase === "done" && (
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 py-2 text-center">
                  <span
                    className="scale-in inline-flex h-14 w-14 items-center justify-center rounded-full text-2xl"
                    style={{
                      background: "var(--accent-soft)",
                      color: "var(--accent-bright)",
                      boxShadow: "0 0 0 1px var(--accent-soft-2), 0 0 30px -4px var(--accent-glow)",
                    }}
                  >
                    ✓
                  </span>
                  <span className="badge badge-accent">
                    {progress?.status === "confirmed"
                      ? `confirmed${progress.eventHeight ? ` · block ${progress.eventHeight}` : ""}`
                      : "broadcast — confirming"}
                  </span>
                  {progress?.status === "timeout" && (
                    <p className="text-xs leading-relaxed text-[var(--fg-muted)]">
                      Broadcast accepted, but confirmation didn&apos;t land in time. It may still confirm.
                    </p>
                  )}
                </div>
                <button className="btn btn-primary btn-md w-full" onClick={close}>
                  Done
                </button>
              </div>
            )}

            {phase === "error" && (
              <div className="space-y-4">
                <div
                  className="flex items-start gap-3 rounded-[var(--r-md)] p-4"
                  style={{ border: "1px solid rgba(248,113,113,0.3)", background: "rgba(248,113,113,0.08)" }}
                >
                  <span className="shrink-0 text-lg" style={{ color: "var(--danger)" }} aria-hidden>⚠</span>
                  <p className="break-words text-sm text-[var(--danger)]">{errMsg}</p>
                </div>
                <button className="btn btn-ghost btn-md w-full" onClick={close}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
