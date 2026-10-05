"use client";

import type { ReactNode } from "react";
import { setMode, useSim } from "@/network/realtime/mode";
import { cx } from "@/lib/format";

/** Renders children only when the visitor has chosen to see simulated data; otherwise the fallback (default nothing). */
export function SimOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <>{useSim() ? children : fallback}</>;
}

/** Inverse: shown only in the default, real-only mode. */
export function RealOnly({ children }: { children: ReactNode }) {
  return <>{useSim() ? null : children}</>;
}

/**
 * Honest stand-in for a section whose figures only exist in the simulated network.
 * Says what is real today, and offers the simulated view behind an explicit click.
 */
export function SimFallback({ title, body, tone = "dark", className }: { title: string; body: string; tone?: "dark" | "light"; className?: string }) {
  const dark = tone === "dark";
  return (
    <div className={cx("rounded-[20px] p-6 ring-1 md:p-8", dark ? "bg-ink-2 text-chalk ring-chalk/[0.08]" : "bg-paper text-ink ring-ink/10", className)}>
      <div className="text-[18px] font-semibold tracking-tight">{title}</div>
      <p className={cx("mt-2.5 max-w-[620px] text-[14px] leading-relaxed", dark ? "text-chalk/60" : "text-ink/60")}>{body}</p>
      <button
        type="button"
        onClick={() => setMode("demo")}
        className={cx("mt-5 inline-flex items-center gap-2 rounded-full px-4 py-2 font-mono text-[11px] uppercase tracking-[0.1em] ring-1 ring-inset transition-colors", dark ? "text-chalk/70 ring-chalk/20 hover:bg-chalk/[0.06] hover:text-chalk" : "text-ink/70 ring-ink/20 hover:bg-ink/[0.04] hover:text-ink")}
      >
        Show simulated data <span className={cx("rounded-sm px-1 text-[9.5px] ring-1", dark ? "text-chalk/45 ring-chalk/20" : "text-ink/45 ring-ink/20")}>SIM</span>
      </button>
    </div>
  );
}
