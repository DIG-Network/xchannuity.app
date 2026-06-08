"use client";
// Landing — shown when no wallet is connected. Private-bank prospectus structure
// with a warm, reassuring voice: securing dependable cashflow for your future and
// the people you love. Restrained chrome, brand mark as section ornament.

import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";
import PoweredByChia from "./PoweredByChia";
import SageBadge from "./SageBadge";

// Small brand hexagon, used as a quiet section ornament.
function Mark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path d="M16 3 27 9v14L16 29 5 23V9z" fill="none" stroke="var(--accent-deep)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M11 20.5c2.5-9 7.5-9 10 0" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--fg-dim)]">{children}</div>
  );
}

// Section header: brand mark, index, hairline rule, quiet title.
function SectionHead({ index, title }: { index?: string; title: string }) {
  return (
    <div className="mb-8 flex items-center gap-3 border-b pb-4" style={{ borderColor: "var(--border)" }}>
      <Mark className="h-4 w-4" />
      {index && <span className="font-mono-num text-xs text-[var(--fg-dim)]">{index}</span>}
      <h2 className="font-serif text-[1.7rem] font-medium leading-none tracking-tight">{title}</h2>
    </div>
  );
}

// A numbered step — large Cormorant numeral as the design element, hairline panel.
function StepCard({ index, term, body }: { index: string; term: string; body: string }) {
  return (
    <div
      className="flex h-full flex-col rounded-[var(--r-md)] border p-6 transition-colors hover:border-[var(--border-strong)]"
      style={{ borderColor: "var(--border)", background: "linear-gradient(180deg, rgba(255,255,255,0.015), transparent 80px)" }}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-serif text-[2.6rem] leading-none text-[var(--fg)]">{index}</span>
        <span className="h-px w-8" style={{ background: "var(--border-strong)" }} />
      </div>
      <div className="mt-5 font-serif text-[1.35rem] font-medium leading-tight tracking-tight">{term}</div>
      <p className="mt-2 text-sm leading-relaxed text-[var(--fg-muted)]">{body}</p>
    </div>
  );
}

// A value proposition — hexagon mark ornament, serif title, hairline panel.
function ValueCard({ term, body }: { term: string; body: string }) {
  return (
    <div
      className="flex h-full flex-col rounded-[var(--r-md)] border p-6 transition-colors hover:border-[var(--border-strong)]"
      style={{ borderColor: "var(--border)", background: "linear-gradient(180deg, rgba(255,255,255,0.015), transparent 80px)" }}
    >
      <Mark className="h-6 w-6" />
      <div className="mt-5 font-serif text-[1.35rem] font-medium leading-tight tracking-tight">{term}</div>
      <p className="mt-2 text-sm leading-relaxed text-[var(--fg-muted)]">{body}</p>
    </div>
  );
}

// Live centerpiece — a vesting annuity that visibly accrues, makes the promise tangible.
function VestingShowpiece() {
  const TOTAL = 3060.0;
  const VESTED_AT_LOAD = 0.42;
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const vested = Math.min(0.999, VESTED_AT_LOAD + t * 0.00002);
  const claimable = (TOTAL * vested * 0.96).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <div
      className="gem flex aspect-square w-full max-w-[26rem] flex-col justify-between p-8"
      style={{ borderRadius: "var(--r-lg)" }}
      aria-hidden
    >
      <div className="flex items-baseline justify-between">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
          <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent)" }} />
          Available to you
        </span>
        <span className="font-mono-num text-[11px] text-[var(--fg-dim)]">wUSDC.b</span>
      </div>

      <div
        className="font-mono-num bg-clip-text text-[3.5rem] font-semibold leading-none tabular-nums text-transparent"
        style={{ backgroundImage: "linear-gradient(180deg, #ffffff, var(--accent-deep))" }}
      >
        {claimable}
      </div>

      <div>
        <div className="mb-2 flex items-baseline justify-between text-[11px] uppercase tracking-[0.14em] text-[var(--fg-dim)]">
          <span>Vested 42%</span>
          <span>1.7 yrs remaining</span>
        </div>
        <div className="stream-track">
          <div className="stream-claimed h-full" style={{ width: "29%" }} />
          <div className="stream-claimable h-full" style={{ width: "13%" }} />
          <div className="stream-tostream h-full" style={{ width: "58%" }} />
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  return (
    <div className="flex flex-col gap-20 sm:gap-28">
      {/* Hero */}
      <section className="grid gap-12 pt-4 md:grid-cols-[1fr_0.9fr] md:items-center">
        <div className="order-2 md:order-1">
          <Eyebrow>Private annuities · a legacy secured by Chia</Eyebrow>
          <h1 className="mt-6 font-serif text-[3.6rem] font-medium leading-[1.0] tracking-[-0.01em] sm:text-[4.7rem]">
            Secure cashflow,
            <br />
            <span className="italic text-[var(--fg-muted)]">second by second.</span>
          </h1>
          <p className="mt-6 max-w-md text-[1.0625rem] leading-relaxed text-[var(--fg-muted)]">
            Set value aside today and let it stream — to yourself in the years ahead, or to the people you love long
            after. An annuity becomes a living legacy: it pays out second by second, can be drawn on whenever it&apos;s
            needed, and passed down like an heirloom. Held by you, enforced by Chia consensus, answerable to no
            institution.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ConnectButton />
            <a href="#how" className="btn btn-ghost btn-md">
              How it works
            </a>
          </div>
          <p className="mt-6 max-w-md border-t pt-5 text-xs leading-relaxed text-[var(--fg-dim)]" style={{ borderColor: "var(--border)" }}>
            Self-custodial. Every claim and transfer is authorized by your own wallet and settled by consensus. Your
            keys never leave Sage — there is no custodian to trust.
          </p>
        </div>

        <div className="order-1 flex justify-center md:order-2">
          <VestingShowpiece />
        </div>
      </section>

      {/* Reassurance / security */}
      <section className="rounded-[var(--r-lg)] border p-6 sm:p-8" style={{ borderColor: "var(--border)" }}>
        <Eyebrow>How it is secured</Eyebrow>
        <div className="mt-3 font-serif text-2xl font-medium tracking-tight">
          A promise kept by code, not by a custodian
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--fg-muted)]">
          Each annuity is built on Yakuhito&apos;s CHIP-0041 Streaming Puzzle, wrapped in Chia&apos;s audited CAT2
          layer. Funds can only ever reach the named beneficiary, the vesting schedule cannot be altered, and a
          permanent annuity can never be reclaimed — properties an heir can rely on for years, or for a generation. No
          reserve, no bridge, no institution standing between you and the legacy you leave. The dApp is fully
          open source — inspect, audit, or fork every line.
        </p>
      </section>

      {/* A better way to provide — two-column statement */}
      <section>
        <SectionHead title="A better way to provide" />
        <div className="grid gap-px overflow-hidden rounded-[var(--r-md)] border sm:grid-cols-2" style={{ borderColor: "var(--border)", background: "var(--border)" }}>
          <div className="bg-[var(--bg)] p-6">
            <Eyebrow>A lump sum</Eyebrow>
            <p className="mt-3 text-sm leading-relaxed text-[var(--fg-muted)]">
              Everything at once, and the hope it lasts. No schedule, no protection against it being spent too soon,
              and nothing you can adjust or trade once it&apos;s handed over.
            </p>
          </div>
          <div className="bg-[var(--bg)] p-6">
            <Eyebrow>An annuity</Eyebrow>
            <p className="mt-3 text-sm leading-relaxed text-[var(--fg-muted)]">
              A dependable stream your beneficiary can count on, arriving second by second over the term. They draw on
              it as they need it — and, because each annuity is a unique coin, it can be inherited, passed down, or
              sold.
            </p>
          </div>
        </div>
      </section>

      {/* How it works — numbered ledger */}
      <section id="how" className="scroll-mt-24">
        <SectionHead index="§1" title="How your annuity works" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StepCard index="01" term="Connect" body="Pair Sage over WalletConnect. We never hold your keys or your funds — the wallet stays yours." />
          <StepCard index="02" term="Set it aside" body="Fund an annuity with a term and a beneficiary — yourself, or someone you love. A 0.5% protocol fee applies once, on creation." />
          <StepCard index="03" term="Draw on it" body="Claim what has accrued at any time, in a single spend. The balance keeps growing every second until the term ends." />
          <StepCard index="04" term="Pass on or sell" body="Assign the annuity to a new owner outright, or list it as a trustless offer for XCH or another stablecoin." />
        </div>
      </section>

      {/* Why — ledger */}
      <section>
        <SectionHead index="§2" title="Why an annuity" />
        <div className="grid gap-4 sm:grid-cols-3">
          <ValueCard term="Income they can count on" body="On-chain linear vesting. The available balance grows every second from start to end — no oracle, no scheduler, no missed payment." />
          <ValueCard term="Leave a legacy" body="Stream to a child or loved one over years. A permanent annuity can never be clawed back — a gift that stays theirs, exactly as you intended, long after you set it in motion." />
          <ValueCard term="Yours to pass down" body="Each annuity is a unique coin. Keep it, hand it down to an heir, or sell the remaining stream through a standard, trustless offer." />
        </div>
      </section>

      {/* Trust / logos */}
      <section className="flex flex-col items-center gap-6">
        <Eyebrow>Built on</Eyebrow>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <PoweredByChia />
          <SageBadge />
        </div>
      </section>

      {/* Closing */}
      <section
        className="flex flex-wrap items-center justify-between gap-5 rounded-[var(--r-lg)] border p-7 sm:p-8"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-4">
          <Mark className="h-8 w-8" />
          <div>
            <div className="font-serif text-2xl font-medium tracking-tight">Begin a legacy today</div>
            <p className="mt-1.5 text-sm text-[var(--fg-muted)]">Connect Sage and set your first annuity in motion — in a single signature.</p>
          </div>
        </div>
        <ConnectButton />
      </section>
    </div>
  );
}
