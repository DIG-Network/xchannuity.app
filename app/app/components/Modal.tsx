"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title: string;
}

// Portal-based, accessible modal (ported from the cXCH reference). Renders
// through createPortal so the fixed overlay escapes ancestors with backdrop
// filters; role=dialog + focus trap + Escape + scroll lock.
export default function Modal({ isOpen, onClose, children, title }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Hold the latest onClose in a ref so the focus-trap effect below depends only
  // on [mounted, isOpen] — not on a fresh onClose identity each parent render.
  // Otherwise a parent that re-renders every tick (e.g. a countdown) re-runs the
  // effect and steals focus from inputs every second.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !isOpen) return;

    prevFocus.current = (document.activeElement as HTMLElement) ?? null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = (): HTMLElement[] => {
      const card = cardRef.current;
      if (!card) return [];
      return Array.from(
        card.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    const raf = requestAnimationFrame(() => {
      const f = focusables();
      (f[0] ?? cardRef.current)?.focus();
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        cardRef.current?.focus();
        return;
      }
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || !cardRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus.current?.focus?.();
    };
  }, [mounted, isOpen]);

  if (!mounted || !isOpen) return null;

  const overlay = (
    <div
      className="fade-in fixed inset-0 z-[1000] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="scale-in panel relative w-full max-w-md p-6"
        style={{ maxHeight: "min(85vh, calc(100vh - 2rem))", overflowY: "auto", boxShadow: "var(--shadow-pop)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between border-b pb-4" style={{ borderColor: "var(--border)" }}>
          <h3 id={titleId} className="font-serif text-2xl font-medium tracking-tight">
            {title}
          </h3>
          <button
            onClick={onClose}
            className="-mr-1 rounded-lg p-1.5 text-[var(--fg-dim)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--fg)]"
            aria-label="Close dialog"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
