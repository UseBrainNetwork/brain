"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WalletButton } from "@/components/wallet/WalletButton";
import { Prov } from "@/components/ui";
import { cx } from "@/lib/format";
import { getToken } from "@/services/data";
import { Logo } from "./Logo";

const links = [
  { href: "/brain", label: "Network" },
  { href: "/contribute", label: "Contribute" },
  { href: "/inference", label: "Inference" },
  { href: "/explorer", label: "Explorer" },
  { href: "/rewards", label: "Rewards" },
  { href: "/developers", label: "Developers" },
];

/** Reads the theme of whatever section is under the nav so it can invert over dark surfaces. */
function useSurfaceTheme() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = document.elementsFromPoint(window.innerWidth / 2, 36).find((e) => !e.closest("header"));
      const host = el?.closest<HTMLElement>("[data-theme]");
      setDark(host?.dataset.theme === "dark");
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    const t = setInterval(check, 800);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      clearInterval(t);
      cancelAnimationFrame(raf);
    };
  }, []);
  return dark;
}

export function Nav() {
  const path = usePathname();
  const dark = useSurfaceTheme();
  const [open, setOpen] = useState(false);
  const token = getToken();
  useEffect(() => setOpen(false), [path]);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50">
      <div className="mx-auto flex h-[72px] max-w-[1440px] items-center justify-between gap-4 px-5 md:px-10">
        <Link href="/" aria-label="BRAIN home" className={cx("pointer-events-auto transition-colors duration-300", dark ? "text-chalk" : "text-ink")}>
          <Logo />
        </Link>

        <nav
          className={cx(
            "pointer-events-auto hidden items-center rounded-full p-1 backdrop-blur-md transition-colors duration-300 lg:flex",
            dark ? "bg-ink-2/80 shadow-[inset_0_0_0_1px_rgba(238,236,230,0.1)]" : "bg-paper/75 shadow-[inset_0_0_0_1px_rgba(17,17,16,0.08)]",
          )}
        >
          {links.map((l) => {
            const active = path === l.href || path.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={cx(
                  "rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-colors xl:px-3.5",
                  dark
                    ? active
                      ? "bg-chalk/10 text-chalk"
                      : "text-chalk/70 hover:text-chalk"
                    : active
                      ? "bg-ink/[0.07] text-ink"
                      : "text-ink/70 hover:text-ink",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="pointer-events-auto flex items-center gap-2">
          <div
            className={cx(
              "hidden h-9 items-center gap-2 rounded-full px-3 font-mono text-[12px] transition-colors duration-300 md:flex lg:hidden xl:flex",
              dark ? "text-chalk/80" : "text-ink/80",
            )}
            title="Demo price — not market data"
          >
            <span>{token.symbol}</span>
            <span className="num">${token.priceUsd.toFixed(6)}</span>
            <Prov p="simulated" />
          </div>
          <WalletButton dark={dark} />
          <button
            onClick={() => setOpen((v) => !v)}
            className={cx(
              "grid size-10 place-items-center rounded-full lg:hidden",
              dark ? "bg-chalk/10 text-chalk" : "bg-ink/[0.06] text-ink",
            )}
            aria-label="Menu"
            aria-expanded={open}
          >
            <span className="flex flex-col gap-[5px]">
              <span className={cx("block h-[1.5px] w-4 bg-current transition-transform", open && "translate-y-[3.25px] rotate-45")} />
              <span className={cx("block h-[1.5px] w-4 bg-current transition-transform", open && "-translate-y-[3.25px] -rotate-45")} />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div className="pointer-events-auto mx-3 rounded-2xl bg-ink p-2 text-chalk shadow-2xl lg:hidden">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="flex items-center justify-between rounded-xl px-4 py-3.5 text-[17px] font-medium hover:bg-chalk/5">
              {l.label}
              <span className="text-fog">→</span>
            </Link>
          ))}
          <div className="flex items-center gap-2 px-4 py-3 font-mono text-[12px] text-fog">
            {token.symbol} ${token.priceUsd.toFixed(6)} <Prov p="simulated" />
          </div>
        </div>
      )}
    </header>
  );
}
