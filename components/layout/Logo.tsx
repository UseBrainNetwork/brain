import { cx } from "@/lib/format";

/** 3×3 compute cells; the lit one is you. */
export function Mark({ className, lit = 4 }: { className?: string; lit?: number }) {
  return (
    <svg viewBox="0 0 22 22" className={cx("shrink-0", className)} aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <rect
          key={i}
          x={(i % 3) * 8}
          y={Math.floor(i / 3) * 8}
          width="6"
          height="6"
          rx="1.2"
          className={i === lit ? "fill-signal" : "fill-current"}
        />
      ))}
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2.5", className)}>
      <Mark className="size-[19px]" />
      <span className="display text-[23px] leading-none tracking-[-0.04em]">brain</span>
    </span>
  );
}
