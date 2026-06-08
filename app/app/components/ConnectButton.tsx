"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import Modal from "./Modal";
import { useSage } from "../lib/walletconnect";

// The "Connect Sage" control. Opens a QR modal when connecting (spinner until
// the relay mints the pairing URI, then the QR + copy-link button); shows a
// disconnect button when connected. Ported from the cXCH reference dApp.
export function ConnectButton() {
  const { session, connect, cancelConnect, disconnect, connecting, qrUri } = useSage();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleModalClose = () => {
    setIsModalOpen(false);
    cancelConnect();
  };

  const handleConnect = async () => {
    setIsModalOpen(true);
    try {
      await connect();
    } catch (e) {
      console.error("Wallet connection failed:", e);
    } finally {
      setIsModalOpen(false);
    }
  };

  const handleCopyLink = async () => {
    if (!qrUri) return;
    try {
      await navigator.clipboard.writeText(qrUri);
      setIsCopied(true);
      toast.success("Link copied!");
      setTimeout(() => setIsCopied(false), 1000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <>
      {session ? (
        <button onClick={disconnect} className="btn btn-ghost btn-sm">
          Disconnect
        </button>
      ) : (
        <button onClick={handleConnect} disabled={connecting} className="btn btn-primary btn-md">
          {connecting ? (
            <>
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Connecting…
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="-ml-0.5">
                <path d="M12 1.5 21.5 7v10L12 22.5 2.5 17V7L12 1.5Z" />
              </svg>
              Connect Sage
            </>
          )}
        </button>
      )}

      <Modal isOpen={isModalOpen} onClose={handleModalClose} title="Connect your wallet">
        <div className="flex flex-col items-center gap-4">
          {qrUri ? (
            <>
              <div className="rounded-2xl bg-white p-4 shadow-[0_0_0_1px_var(--accent-soft-2),0_18px_50px_-12px_var(--accent-glow)]">
                <QRCodeSVG value={qrUri} size={256} />
              </div>
              <button
                onClick={handleCopyLink}
                className={`btn btn-ghost btn-sm ${isCopied ? "!border-[var(--accent)] !text-[var(--accent)]" : ""}`}
              >
                {isCopied ? "✓ Copied!" : "Copy link"}
              </button>
              <p className="mt-1 text-center text-sm text-[var(--fg-muted)]">
                Scan with Sage, or copy the link and paste it into Sage&apos;s WalletConnect dialog.
              </p>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 p-6">
              <div
                className="h-9 w-9 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-[var(--accent)]"
                role="status"
                aria-label="Loading"
              />
              <p className="text-sm text-[var(--fg-dim)]">Opening a secure pairing channel…</p>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
