"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * "BRAIN — stupified": the whole product in three sentences. Opens once per browser on the first
 * visit, and any time something dispatches the `brain:stupified` event (footer link, nav).
 */

const KEY = "brain.stupified.v1";
const EVENT = "brain:stupified";
const QUIET = ["/node", "/demo", "/receipt", "/api"];

export const openStupified = () => window.dispatchEvent(new Event(EVENT));

export function Stupified() {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  useEffect(() => {
    if (QUIET.some((q) => path?.startsWith(q))) return;
    if (new URLSearchParams(window.location.search).has("autostart")) return;
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    const t = setTimeout(() => setOpen(true), 900);
    return () => clearTimeout(t);
  }, [path]);

  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {}
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="stupified"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[90] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
          onClick={close}
          role="dialog"
          aria-modal
          aria-labelledby="stupified-title"
        >
          <motion.div
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            data-theme="dark"
            onClick={(e) => e.stopPropagation()}
            className="surface-dark w-full max-w-[520px] rounded-[22px] bg-ink-2 p-7 text-chalk shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] ring-1 ring-chalk/12 sm:p-9"
          >
            <div className="flex items-start justify-between gap-4">
              <div id="stupified-title" className="font-mono text-[11px] uppercase tracking-[0.18em] text-chalk/50">
                BRAIN <span className="text-chalk/30">—</span> stupified
              </div>
              <button type="button" onClick={close} aria-label="Close" className="-mr-2 -mt-2 grid size-8 place-items-center rounded-full text-chalk/50 hover:bg-chalk/[0.08] hover:text-chalk">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M2 2l10 10M12 2 2 12" />
                </svg>
              </button>
            </div>

            <ol className="mt-6 space-y-5">
              <Line n="1">
                You ask. BRAIN finds the <span className="text-chalk">cheapest computer that can answer</span> and sends you the answer with a receipt.
              </Line>
              <Line n="2">
                Your computer can be one of those computers. Join from this browser. <span className="text-chalk">Earn credits, USDC or SOL.</span>
              </Line>
              <Line n="3">That&apos;s it.</Line>
            </ol>

            <div className="mt-8 flex flex-col gap-2 sm:flex-row">
              <Link href="/chat" onClick={close} className="inline-flex h-12 flex-1 items-center justify-center rounded-full bg-chalk px-5 text-[14.5px] font-semibold text-ink hover:bg-white">
                Ask something
              </Link>
              <Link href="/earn" onClick={close} className="inline-flex h-12 flex-1 items-center justify-center rounded-full px-5 text-[14.5px] font-semibold text-chalk ring-1 ring-inset ring-chalk/20 hover:bg-chalk/[0.06]">
                Power it
              </Link>
            </div>
            <p className="mt-5 text-center font-mono text-[10.5px] text-chalk/30">Only verified work earns. Nothing here promises a return.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Line({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="num mt-[2px] w-5 shrink-0 text-[13px] text-chalk/35">{n}</span>
      <span className="text-[18px] leading-[1.4] text-chalk/70 sm:text-[20px]">{children}</span>
    </li>
  );
}

/** Footer / nav trigger. */
export function StupifiedLink({ className }: { className?: string }) {
  return (
    <button type="button" onClick={openStupified} className={className}>
      BRAIN, stupified
    </button>
  );
}
