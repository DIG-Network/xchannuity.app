"use client";

// PoweredByChia — the "Powered by Chia" chip with a cursor-reactive glow. The
// radial glow blob + the conic border arc both point toward the cursor (CSS
// vars --gx/--gy/--pang/--pglow set from a window pointermove). Styles live in
// globals.css. Ported from the cXCH reference dApp.

import { useEffect, useRef } from "react";

const CHIA_URL = "https://www.chia.net";

export default function PoweredByChia() {
  const chipRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    const chip = chipRef.current;
    if (!chip) return;
    let raf = 0;
    let lastE: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      lastE = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!lastE) return;
        const r = chip.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hw = r.width / 2;
        const hh = r.height / 2;
        const dirx = lastE.clientX - cx;
        const diry = lastE.clientY - cy;
        const scale = 1 / Math.max(Math.abs(dirx) / hw, Math.abs(diry) / hh || 1e-6);
        const bx = dirx * scale;
        const by = diry * scale;
        chip.style.setProperty("--gx", `${hw + bx}px`);
        chip.style.setProperty("--gy", `${hh + by}px`);
        chip.style.setProperty("--pang", `${(Math.atan2(dirx, -diry) * 180) / Math.PI}deg`);
        const dist = Math.hypot(dirx, diry);
        const glow = Math.max(0.5, Math.min(1, 1 - (dist - 120) / 700));
        chip.style.setProperty("--pglow", glow.toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="pbc-wrap">
      <a
        ref={chipRef}
        className="pbc-chip"
        href={CHIA_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Powered by Chia"
      >
        <div className="pbc-glow" aria-hidden />
        <div className="pbc-sheen" aria-hidden />
        <div className="pbc-lbl">Powered by</div>
        <div className="pbc-logos">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="pbc-chia" src="/chia-logo.png" alt="Chia" />
        </div>
      </a>
    </div>
  );
}
