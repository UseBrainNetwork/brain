"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { WalletButton } from "@/components/wallet/WalletButton";
import { cx } from "@/lib/format";
import { Logo } from "./Logo";
import { SocialLinks } from "./SocialLinks";
import { openStupified } from "@/components/layout/Stupified";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/network", label: "Network" },
  { href: "/pricing", label: "Pricing" },
  { href: "/earn", label: "Earn" },
  { href: "/developers", label: "Developers" },
];
const secondary = [
  { href: "/explorer", label: "Explorer", hint: "Every job, node and receipt" },
  { href: "/capacity", label: "Capacity", hint: "What the network can run today" },
  { href: "/economics", label: "Economics", hint: "Where the money moves" },
  { href: "/auto", label: "BRAIN AUTO", hint: "Routing console" },
  { href: "/rewards", label: "Rewards", hint: "Contributor epochs" },
];
const accountLinks = [
  { href: "/account", label: "Account" },
  { href: "/account#api-keys", label: "API keys" },
  { href: "/earn", label: "Compute" },
  { href: "/pricing", label: "Billing" },
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
  const [more, setMore] = useState(false);
  useEffect(() => {
    setOpen(false);
    setMore(false);
  }, [path]);
  useEffect(() => {
    if (!more) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest("[data-more]") && setMore(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [more]);

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
          <div data-more className="relative">
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              className={cx("rounded-full px-3 py-1.5 text-[13.5px] font-medium transition-colors xl:px-3.5", dark ? (more ? "bg-chalk/10 text-chalk" : "text-chalk/70 hover:text-chalk") : more ? "bg-ink/[0.07] text-ink" : "text-ink/70 hover:text-ink")}
            >
              More
            </button>
            {more && (
              <div className="absolute right-0 top-[calc(100%+10px)] w-[300px] rounded-[16px] bg-ink p-2 text-chalk shadow-2xl ring-1 ring-chalk/10">
                {secondary.map((l) => (
                  <Link key={l.href} href={l.href} className="flex items-center justify-between rounded-[10px] px-3 py-2.5 hover:bg-chalk/5">
                    <span>
                      <span className="block text-[13.5px] font-medium">{l.label}</span>
                      <span className="block text-[11.5px] text-chalk/45">{l.hint}</span>
                    </span>
                    <span className="text-fog">→</span>
                  </Link>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setMore(false);
                    openStupified();
                  }}
                  className="flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left hover:bg-chalk/5"
                >
                  <span>
                    <span className="block text-[13.5px] font-medium">BRAIN, stupified</span>
                    <span className="block text-[11.5px] text-chalk/45">The whole thing in three sentences</span>
                  </span>
                  <span className="text-fog">→</span>
                </button>
                <div className="mt-1 border-t border-chalk/10 px-3 pb-1 pt-2.5">
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-chalk/40">Account</div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
                    {accountLinks.map((l) => (
                      <Link key={l.label} href={l.href} className="text-chalk/75 hover:text-chalk">
                        {l.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </nav>

        <div className="pointer-events-auto flex items-center gap-2">
          <SocialLinks dark={dark} className="hidden md:flex" />
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
          <div className="mt-1 grid grid-cols-2 gap-1 border-t border-chalk/10 pt-2">
            {[...secondary, ...accountLinks.filter((a) => a.label === "Account")].map((l) => (
              <Link key={l.href + l.label} href={l.href} className="rounded-lg px-4 py-2.5 text-[14px] text-chalk/75 hover:bg-chalk/5 hover:text-chalk">
                {l.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center justify-end px-4 py-3">
            <SocialLinks dark size="md" />
          </div>
        </div>
      )}
    </header>
  );
}
