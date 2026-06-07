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
      className="group inline-flex flex-col items-center gap-2.5 rounded-[18px] border border-[rgba(94,206,113,0.28)] bg-[rgba(8,22,12,0.5)] px-7 py-3.5 no-underline shadow-[0_12px_40px_rgba(0,0,0,0.4)] backdrop-blur transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-[3px] hover:scale-[1.04] hover:border-[rgba(94,206,113,0.7)] hover:shadow-[0_14px_40px_rgba(0,0,0,0.4),0_0_28px_rgba(94,206,113,0.45)]"
    >
      <span className="text-xs uppercase tracking-[0.2em] text-gray-400">Best with</span>
      <span className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/sage-logo.png"
          alt="Sage"
          className="h-[30px] w-[30px] rounded-lg drop-shadow-[0_0_10px_rgba(94,206,113,0.4)] transition group-hover:drop-shadow-[0_0_14px_rgba(94,206,113,0.75)]"
        />
        <span className="text-[22px] font-bold leading-none" style={{ color: "var(--fg)" }}>
          Sage Wallet
        </span>
      </span>
    </a>
  );
}
