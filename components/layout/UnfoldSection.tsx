"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/lib/format";

function previousTheme(el: HTMLElement): string | null {
  let prev = el.previousElementSibling as HTMLElement | null;
  while (prev && prev.tagName === "MAIN") prev = prev.lastElementChild as HTMLElement | null;
  if (!prev) return null;
  return prev.dataset.theme ?? prev.querySelector<HTMLElement>("[data-theme]")?.dataset.theme ?? null;
}

/**
 * A dark section that enters as an inset rounded panel and opens to full bleed as it reaches
 * the top of the viewport, so light → dark changes read as one surface expanding.
 * Skipped when the previous section is already dark.
 */
export function UnfoldSection({ children, className, id, as = "section" }: { children: ReactNode; className?: string; id?: string; as?: "section" | "footer" }) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as === "footer" ? motion.footer : motion.section;
  const reduced = useReducedMotion();
  const [afterLight, setAfterLight] = useState(false);
  const path = usePathname();
  useEffect(() => {
    if (ref.current) setAfterLight(previousTheme(ref.current) === "light");
  }, [path]);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "start 0.15"] });
  const inset = useTransform(scrollYProgress, [0, 1], [4, 0]);
  const radius = useTransform(scrollYProgress, [0, 1], [40, 0]);
  const clipPath = useTransform([inset, radius], ([i, r]) => `inset(0 ${i}% 0 ${i}% round ${r}px ${r}px 0 0)`);
  return (
    <Tag ref={ref} id={id} data-theme="dark" style={reduced || !afterLight ? undefined : { clipPath }} className={cx("surface-dark relative", className)}>
      {children}
    </Tag>
  );
}
