"use client";
import { useEffect, useState } from "react";
import { Toaster } from "react-hot-toast";
import { WalletConnectProvider, useSage } from "./lib/walletconnect";
import { ensureWasm } from "./lib/wasm";
import { Landing } from "./components/Landing";
import { Dashboard } from "./components/Dashboard";
import { ConnectButton } from "./components/ConnectButton";
import { SpendConfirmProvider } from "./components/SpendConfirm";

function BrandMark() {
  return (
    <span className="relative inline-flex h-8 w-8 items-center justify-center" aria-hidden>
      <svg viewBox="0 0 32 32" className="h-8 w-8">
        <defs>
          <linearGradient id="hexg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent-bright)" />
            <stop offset="1" stopColor="var(--accent-deep)" />
          </linearGradient>
        </defs>
        <path
          d="M16 2.5 27.5 9v14L16 29.5 4.5 23V9z"
          fill="none"
          stroke="url(#hexg)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M11 20.5c2.5-9 7.5-9 10-0" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function Header() {
  const { session } = useSage();
  return (
    <header className="panel-glass sticky top-0 z-30 border-b" style={{ borderColor: "var(--border)" }}>
      <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 sm:px-6">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <span className="font-display text-[1.05rem] font-bold tracking-tight">
            XCH <span style={{ color: "var(--accent)" }}>Annuity</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {session && (
            <span className="hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium text-[var(--fg-muted)] sm:inline-flex"
              style={{ borderColor: "var(--border)" }}>
              <span className="live-dot h-2 w-2 rounded-full" style={{ background: "var(--accent)" }} />
              Sage connected
            </span>
          )}
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

function Shell() {
  const { session } = useSage();
  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl px-5 py-10 sm:px-6">
        {session ? (
          <SpendConfirmProvider>
            <div key="dash" className="fade-in">
              <Dashboard />
            </div>
          </SpendConfirmProvider>
        ) : (
          <div key="land" className="fade-in">
            <Landing />
          </div>
        )}
      </main>
      <footer className="mx-auto max-w-5xl px-5 pb-10 pt-4 text-center text-xs text-[var(--fg-dim)] sm:px-6">
        Self-custodial · streamed CATs on Chia · enforced by consensus
      </footer>
    </>
  );
}

function BootScreen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center">
      {children}
    </main>
  );
}

export default function Page() {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    ensureWasm()
      .then(() => setReady(true))
      .catch((e) => setErr(String((e as Error)?.message ?? e)));
  }, []);

  return (
    <WalletConnectProvider>
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: "rgba(14,20,15,0.92)",
            color: "var(--fg)",
            border: "1px solid var(--border-strong)",
            borderRadius: "12px",
            fontSize: "0.875rem",
            backdropFilter: "blur(8px)",
          },
          success: { iconTheme: { primary: "var(--accent)", secondary: "var(--accent-ink)" } },
          error: { iconTheme: { primary: "var(--danger)", secondary: "#1a0a0a" } },
        }}
      />
      {err ? (
        <BootScreen>
          <div
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: "rgba(248,113,113,0.12)", color: "var(--danger)" }}
            aria-hidden
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
          </div>
          <div>
            <p className="font-display text-lg font-semibold text-[var(--danger)]">Engine failed to load</p>
            <p className="mt-1 max-w-md break-words text-sm text-[var(--fg-muted)]">{err}</p>
            <p className="mt-3 text-xs text-[var(--fg-dim)]">
              Rebuild the WASM package: <span className="font-mono-num">npm run build:wasm</span>
            </p>
          </div>
        </BootScreen>
      ) : ready ? (
        <Shell />
      ) : (
        <BootScreen>
          <div className="relative h-14 w-14" role="status" aria-label="Loading">
            <div className="absolute inset-0 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]" />
            <div className="absolute inset-[6px] rounded-full" style={{ background: "var(--accent-soft)" }} />
          </div>
          <div>
            <p className="font-display text-base font-semibold">Starting the annuity engine</p>
            <p className="mt-1 text-sm text-[var(--fg-dim)]">Loading the on-chain vesting core…</p>
          </div>
        </BootScreen>
      )}
    </WalletConnectProvider>
  );
}
