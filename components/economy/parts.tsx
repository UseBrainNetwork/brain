import Link from "next/link";
import type { ReactNode } from "react";
import type { Money, Source } from "@/domain/economy";
import { cx, fmtInt } from "@/lib/format";

/** Shared primitives for the economic layer pages. Dark, mono, no decoration. */

export function SourceBadge({ source, className }: { source: Source; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em]", source === "REAL" ? "bg-ok/15 text-ok" : "bg-chalk/10 text-chalk/60", className)}>
      <span className={cx("inline-block size-[5px]", source === "REAL" ? "bg-ok" : "bg-chalk/50")} />
      {source}
    </span>
  );
}

export function Panel({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-[14px] border border-chalk/10 bg-chalk/[0.025] p-5 md:p-6", className)}>
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between gap-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-chalk/45">
          <span>{title}</span>
          <span>{right}</span>
        </div>
      )}
      {children}
    </section>
  );
}

/** A metric that is honest about missing data. */
export function Metric({ k, v, sub, tone, big }: { k: ReactNode; v: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "bad" | "muted"; big?: boolean }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-signal" : tone === "muted" ? "text-chalk/40" : "text-chalk";
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">{k}</div>
      <div className={cx("num mt-1 flex min-h-[22px] items-end leading-none", big ? "text-[34px] md:text-[40px]" : "text-[22px]", color)}>{v}</div>
      {sub && <div className="mt-1.5 font-mono text-[10.5px] text-chalk/40">{sub}</div>}
    </div>
  );
}

export const NO_DATA = <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-chalk/35">Not enough data</span>;
export const UNKNOWN = <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-chalk/35">Unknown</span>;

export function usd(n: number | null | undefined, digits = 4): ReactNode {
  if (n == null) return UNKNOWN;
  // Sub-cent amounts are real at browser-compute prices; never round a non-zero cost to $0.0000.
  if (n > 0 && n < 10 ** -digits) return `$${n.toFixed(Math.min(12, Math.ceil(-Math.log10(n)) + 1))}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 1 ? digits : 2, maximumFractionDigits: n < 1 ? digits : 2 })}`;
}

export function money(m: Money | null | undefined): ReactNode {
  if (!m) return UNKNOWN;
  return (
    <span>
      {usd(m.amount)} <span className="text-chalk/35">· {m.basis}</span>
    </span>
  );
}

export const sol = (lamports: number) => `${(lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;

export function Hash({ value, label }: { value: string; label?: string }) {
  return (
    <div className="font-mono text-[11px]">
      {label && <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-chalk/45">{label}</div>}
      <div className="break-all rounded-[6px] bg-ink-2 px-3 py-2 text-chalk/80">{value}</div>
    </div>
  );
}

export function NodeLink({ id }: { id: string }) {
  return (
    <Link href={`/node/${id}`} className="font-mono text-chalk underline decoration-chalk/25 underline-offset-4 hover:decoration-chalk">
      {id}
    </Link>
  );
}

export function PageHead({ eyebrow, title, right, children }: { eyebrow: ReactNode; title: ReactNode; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col justify-between gap-6 border-b border-chalk/10 pb-8 md:flex-row md:items-end">
      <div>
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.16em] text-chalk/45">{eyebrow}</div>
        <h1 className="display mt-3 text-[40px] text-chalk md:text-[64px]">{title}</h1>
        {children && <div className="mt-4 max-w-[640px] text-[14px] leading-relaxed text-chalk/55">{children}</div>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-theme="dark" className="surface-dark min-h-dvh pb-24 pt-[110px] md:pt-[130px]">
      <div className="mx-auto w-full max-w-[1280px] px-5 md:px-10">{children}</div>
    </div>
  );
}

export const n = (x: number | null | undefined, suffix = "") => (x == null ? NO_DATA : `${fmtInt(x)}${suffix}`);
export const pct = (x: number | null | undefined, digits = 1) => (x == null ? NO_DATA : `${(x * 100).toFixed(digits)}%`);
export const ms = (x: number | null | undefined) => (x == null ? UNKNOWN : x >= 1000 ? `${(x / 1000).toFixed(2)}s` : `${Math.round(x)}ms`);
export const when = (t: number | null | undefined): ReactNode => (t == null || !Number.isFinite(t) ? UNKNOWN : new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z");
