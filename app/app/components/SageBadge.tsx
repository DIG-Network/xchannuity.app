"use client";

// SageBadge — companion to PoweredByChia. XCH Annuity connects through Sage
// Wallet over WalletConnect, so this links to the Sage download. Styled to
// mirror the Powered-by-Chia chip so the two read as a cohesive pair.

const SAGE_URL = "https://sagewallet.net/";

export default function SageBadge() {
  return (
    <a
      href={SAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Download Sage Wallet"
      title="Download Sage Wallet"
      className="group inline-flex flex-col items-center gap-2.5 rounded-[18px] border border-[rgba(203,210,222,0.2)] bg-[rgba(19,20,24,0.6)] px-7 py-3.5 no-underline shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur transition-[box-shadow,border-color] duration-300 hover:border-[rgba(203,210,222,0.4)] hover:shadow-[0_14px_40px_rgba(0,0,0,0.45),0_0_24px_rgba(203,210,222,0.12)]"
    >
      <span className="text-xs uppercase tracking-[0.2em] text-[var(--fg-dim)]">Best with</span>
      <span className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/sage-logo.png"
          alt="Sage"
          className="h-[30px] w-[30px] rounded-lg transition"
          style={{ filter: "grayscale(1) brightness(1.4)" }}
        />
        <span className="text-[22px] font-bold leading-none" style={{ color: "var(--fg)" }}>
          Sage Wallet
        </span>
      </span>
    </a>
  );
}
