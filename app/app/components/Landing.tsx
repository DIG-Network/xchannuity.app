"use client";
// Landing — shown when no wallet is connected. Hero (message + live vesting
// centerpiece), trust callout, what-it-is compare, how-it-works steps,
// why-use-it features, trust badges, closing CTA.

import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";
import PoweredByChia from "./PoweredByChia";
import SageBadge from "./SageBadge";

function HowCard({
  step,
  icon,
  title,
  body,
}: {
  step?: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="panel lift h-full p-5">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-lg"
          style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-soft-2)" }}
          aria-hidden
        >
          {icon}
        </span>
        {step && (
          <span className="font-mono-num text-[11px] font-semibold tracking-widest text-[var(--fg-dim)]">{step}</span>
        )}
      </div>
      <div className="mt-3.5 font-display font-semibold">{title}</div>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--fg-muted)]">{body}</p>
    </div>
  );
}

// Live centerpiece — a vesting annuity that visibly accrues, sells the metaphor.
function VestingShowpiece() {
  const TOTAL = 3060.0;
  const VESTED_AT_LOAD = 0.42;
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // gently tick the claimable up so the number is alive
  const vested = Math.min(0.999, VESTED_AT_LOAD + t * 0.00002);
  const claimable = (TOTAL * vested * 0.96).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <div
      className="relative isolate flex aspect-square w-full max-w-[20rem] flex-col items-center justify-center overflow-hidden rounded-[var(--r-xl)] p-7"
      style={{
        background:
          "radial-gradient(130% 120% at 50% -10%, rgba(74,222,128,0.22), rgba(74,222,128,0.04) 55%, transparent 80%), var(--panel)",
        border: "1px solid var(--accent-soft-2)",
        boxShadow: "inset 0 0 0 1px rgba(74,222,128,0.10), 0 30px 80px -28px var(--accent-glow)",
      }}
      aria-hidden
    >
      {/* orbiting accent ring */}
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full opacity-40 blur-2xl"
        style={{ background: "radial-gradient(circle, var(--accent-glow), transparent 70%)" }}
      />
      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
        <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
        claimable now
      </span>
      <span className="font-mono-num mt-2 text-[2.75rem] font-bold leading-none tabular-nums" style={{ color: "var(--accent-bright)" }}>
        {claimable}
      </span>
      <span className="mt-1.5 text-xs font-medium text-[var(--fg-dim)]">wUSDC.b</span>
      <div className="mt-6 w-full">
        <div className="stream-track">
          <div className="stream-claimed h-full" style={{ width: "29%" }} />
          <div className="stream-claimable h-full" style={{ width: "13%" }} />
          <div className="stream-tostream h-full" style={{ width: "58%" }} />
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-[var(--fg-dim)]">
          <span>42% vested</span>
          <span>1.7 yrs remaining</span>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="flex flex-col gap-16 sm:gap-20">
      {/* Hero */}
      <section className="grid gap-10 pt-2 md:grid-cols-[1.15fr_0.85fr] md:items-center">
        <div className="order-2 md:order-1">
          <span className="badge badge-accent rise-in mb-5" style={{ animationDelay: "0.05s" }}>
            ⬡ streamed · transferable · tradable
          </span>
          <h1
            className="rise-in font-display text-[2.6rem] font-extrabold leading-[1.04] tracking-tight sm:text-[3.4rem]"
            style={{ animationDelay: "0.1s" }}
          >
            Annuities that vest
            <br />
            <span style={{ color: "var(--accent)" }}>by the second.</span>
          </h1>
          <p
            className="rise-in mt-5 max-w-md text-[1.0625rem] leading-relaxed text-[var(--fg-muted)]"
            style={{ animationDelay: "0.18s" }}
          >
            XCH Annuity streams a stablecoin to a beneficiary <strong className="text-[var(--fg)]">continuously</strong>{" "}
            over a fixed term. Claim what&apos;s accrued whenever you like, hand the whole remaining annuity to someone
            else in a single spend, or sell it through a trustless offer.
          </p>
          <div className="rise-in mt-7 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.26s" }}>
            <ConnectButton />
            <a href="#how" className="btn btn-ghost btn-md">
              How it works
            </a>
          </div>
          <p className="rise-in mt-4 max-w-md text-xs leading-relaxed text-[var(--fg-dim)]" style={{ animationDelay: "0.32s" }}>
            <span className="font-semibold text-[var(--fg-muted)]">Self-custodial.</span> Claims and transfers are
            authorized by your own wallet signature and enforced by Chia consensus. Your keys never leave Sage.
          </p>
        </div>

        <div className="order-1 flex justify-center md:order-2">
          <div className="scale-in" style={{ animationDelay: "0.2s" }}>
            <VestingShowpiece />
          </div>
        </div>
      </section>

      {/* Trust callout */}
      <section
        className="flex items-start gap-4 rounded-[var(--r-lg)] p-5 sm:p-6"
        style={{
          border: "1px solid var(--accent-soft-2)",
          background: "linear-gradient(180deg, var(--accent-soft), transparent), var(--panel)",
        }}
      >
        <span
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg"
          style={{ background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-soft-2)" }}
          aria-hidden
        >
          🛡️
        </span>
        <div>
          <div className="font-display font-semibold">Built on CHIP-0041 streaming + the audited CAT2 layer</div>
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--fg-muted)]">
            The vesting engine is Yakuhito&apos;s CHIP-0041 Streaming Puzzle, wrapped in Chia&apos;s standard{" "}
            <strong className="text-[var(--fg)]">CAT2</strong> layer. The only addition is a minimal{" "}
            <strong className="text-[var(--fg)]">transfer mode</strong> that lets the owner reassign or sell the
            annuity — authorized by a wallet message, never by an in-puzzle key. Funds can only ever reach the curried
            beneficiary; consensus enforces the rest.
          </p>
        </div>
      </section>

      {/* What it is — compare */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="panel relative overflow-hidden p-6">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--fg-dim)]">A lump sum</span>
          <p className="mt-3 text-sm leading-relaxed text-[var(--fg-muted)]">
            All-or-nothing. The recipient gets everything at once, or waits for a manual payout. No inherent schedule,
            and nothing to trade mid-term.
          </p>
        </div>
        <div
          className="relative overflow-hidden rounded-[var(--r-lg)] p-6"
          style={{
            border: "1px solid var(--accent-soft-2)",
            background: "linear-gradient(180deg, var(--accent-soft), transparent 60%), var(--panel)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--accent)" }}>
            An XCH Annuity
          </span>
          <p className="mt-3 text-sm leading-relaxed text-[var(--fg-muted)]">
            The same value, vesting linearly second-by-second over the term. The beneficiary claims accrued value
            anytime, and — because each annuity is a unique coin — can transfer or sell the remaining stream like an
            NFT.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-24">
        <h2 className="font-display text-xl font-bold tracking-tight">How it works</h2>
        <p className="mb-5 mt-1 text-sm text-[var(--fg-muted)]">Connect, create, then claim or trade — all self-custodial.</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <HowCard step="01" icon="🔗" title="Connect" body="Pair Sage over WalletConnect. XCH Annuity never holds your keys or funds." />
          <HowCard step="02" icon="🌱" title="Create" body="Fund a streamed CAT with a term and a beneficiary. A 0.5% fee applies on create only." />
          <HowCard step="03" icon="↓" title="Claim" body="Pull vested value anytime in one spend; the remainder keeps streaming." />
          <HowCard step="04" icon="↔" title="Transfer / Sell" body="Hand the annuity to a new owner, or list it as a trustless offer." />
        </div>
      </section>

      {/* Why */}
      <section>
        <h2 className="mb-5 font-display text-xl font-bold tracking-tight">Why XCH Annuity</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <HowCard icon="⏱️" title="Vests by the second" body="On-chain linear vesting. The claimable balance grows every second from start to end — no oracle, no off-chain scheduler." />
          <HowCard icon="🔑" title="You stay in control" body="Owner-authorized claims and transfers. A permanent annuity can never be clawed back — the property a buyer relies on." />
          <HowCard icon="🧩" title="Tradable like an NFT" body="Each annuity is a unique coin. Sell the remaining stream for XCH or another CAT through a standard, trustless offer." />
        </div>
      </section>

      {/* Powered by Chia + Best with Sage */}
      <section className="flex flex-wrap items-center justify-center gap-4">
        <PoweredByChia />
        <SageBadge />
      </section>

      {/* Closing CTA */}
      <section
        className="relative flex flex-wrap items-center justify-between gap-5 overflow-hidden rounded-[var(--r-xl)] p-7 sm:p-8"
        style={{
          border: "1px solid var(--accent-soft-2)",
          background:
            "radial-gradient(80% 140% at 100% 0%, var(--accent-soft), transparent 60%), var(--panel)",
        }}
      >
        <div>
          <div className="font-display text-lg font-bold">Ready to create one?</div>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">Connect Sage and mint your first annuity in one signature.</p>
        </div>
        <ConnectButton />
      </section>
    </div>
  );
}
