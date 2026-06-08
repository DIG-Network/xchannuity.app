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
          <span className="font-serif text-[1.5rem] font-semibold leading-none tracking-tight">
            XCH <span className="italic" style={{ color: "var(--fg-muted)" }}>Annuity</span>
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
          <a
            href="https://github.com/DIG-Network/xchannuity.app"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View Xchannuity on GitHub"
            title="View on GitHub"
            className="inline-flex items-center gap-1.5 rounded-[var(--r-sm)] border px-3 py-2 text-sm text-[var(--fg-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)]"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="hidden sm:inline">GitHub</span>
          </a>
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
        Self-custodial · streamed CATs on Chia · enforced by consensus ·{" "}
        <a
          href="https://github.com/DIG-Network/xchannuity.app"
          target="_blank"
          rel="noopener noreferrer"
          className="underline transition-colors hover:text-[var(--fg-muted)]"
        >
          open source
        </a>
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
