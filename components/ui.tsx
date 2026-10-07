"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Provenance } from "@/domain/types";
import { cx } from "@/lib/format";

type Tone = "dark" | "light";

export function Button({
  href,
  onClick,
  children,
  variant = "primary",
  tone = "light",
  disabled,
  className,
  arrow,
  type = "button",
}: {
  href?: string;
  onClick?: () => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "signal";
  /** Surface the button sits on. */
  tone?: Tone;
  disabled?: boolean;
  className?: string;
  arrow?: boolean;
  type?: "button" | "submit";
}) {
  const base =
    "group inline-flex items-center justify-center gap-2 rounded-full h-11 px-5 text-[14px] font-semibold tracking-[-0.01em] transition-[background,color,transform,box-shadow] duration-200 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none select-none whitespace-nowrap";
  const styles = {
    primary: tone === "light" ? "bg-ink text-chalk hover:bg-ink-3" : "bg-chalk text-ink hover:bg-bone",
    secondary:
      tone === "light"
        ? "bg-transparent text-ink ring-1 ring-inset ring-ink/20 hover:ring-ink/50"
        : "bg-transparent text-chalk ring-1 ring-inset ring-chalk/20 hover:ring-chalk/55",
    signal: "bg-signal text-white hover:bg-signal-2",
  }[variant];
  const inner = (
    <>
      {children}
      {arrow && <span className="transition-transform duration-200 group-hover:translate-x-0.5">→</span>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cx(base, styles, className)}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cx(base, styles, className)}>
      {inner}
    </button>
  );
}

const provLabel: Record<Provenance, string> = { live: "LIVE", simulated: "SIM", estimated: "EST" };

/** Every number that is not real carries one of these. */
export function Prov({ p, className }: { p: Provenance; className?: string }) {
  const style =
    p === "live"
      ? "text-ok shadow-[inset_0_0_0_1px_currentColor]"
      : p === "estimated"
        ? "text-warn shadow-[inset_0_0_0_1px_currentColor]"
        : "text-fog shadow-[inset_0_0_0_1px_currentColor]";
  return (
    <span
      title={p === "simulated" ? "Simulated demo data" : p === "estimated" ? "Illustrative estimate" : "Real, from this server"}
      className={cx("inline-flex h-[15px] items-center rounded-[3px] px-1 font-mono text-[9px] font-medium leading-none tracking-[0.08em]", style, className)}
    >
      {provLabel[p]}
    </span>
  );
}

export function Dot({ color = "signal", pulse, className }: { color?: "signal" | "ok" | "warn" | "fog"; pulse?: boolean; className?: string }) {
  const c = { signal: "bg-signal", ok: "bg-ok", warn: "bg-warn", fog: "bg-fog" }[color];
  return <span className={cx("inline-block size-[6px] shrink-0", c, pulse && "animate-pulse-dot", className)} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("label opacity-60", className)}>{children}</div>;
}

/** Smoothly animates to the latest value; digits roll rather than jump. */
/** Odometer: each digit is a 0–9 column that rolls to its value. Columns are keyed from the right so they persist as the string grows.
 *  Digit strips are drawn by CSS (globals.css) so the page text stays the real number. */
export function Odometer({ text, className, fast }: { text: string; className?: string; fast?: boolean }) {
  const chars = text.split("");
  return (
    <span className={cx("odo num", fast && "odo-fast", className)}>
      <span className="sr-only">{text}</span>
      {chars.map((c, i) => {
        const key = chars.length - i;
        if (c < "0" || c > "9") {
          return (
            <span key={`s${key}`} aria-hidden className="odo-sym" data-c={c} />
          );
        }
        return (
          <span key={`d${key}`} aria-hidden className="odo-col">
            <span className="odo-strip" style={{ transform: `translateY(${-Number(c) * 10}%)` }} />
          </span>
        );
      })}
    </span>
  );
}

export function Counter({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  return <Odometer text={format(value)} className={className} />;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("label flex items-center gap-2", className)}>{children}</div>;
}

export function Section({
  tone = "light",
  children,
  className,
  id,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} data-theme={tone} className={cx(tone === "dark" ? "surface-dark" : "surface-light", "relative", className)}>
      {children}
    </section>
  );
}

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto w-full max-w-[1440px] px-5 md:px-10", className)}>{children}</div>;
}

export function KV({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 border-b hairline py-2 font-mono text-[12px]", className)}>
      <span className="opacity-55">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
