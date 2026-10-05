"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/format";

type Interest = { plans: string[]; email: string | null };

/**
 * "Tell me when it opens" for a coming-soon plan. Stores interest on the account; nothing is charged.
 * After saving, a confirmation panel says exactly what happened and offers an optional email so the
 * promise to notify can actually be kept. Without an email the plan simply shows under Account.
 */
export function NotifyButton({ plan, planName, dark }: { plan: string; planName?: string; dark?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/account/interest", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Interest) => {
        if (Array.isArray(j.plans) && j.plans.includes(plan)) setState("done");
        if (typeof j.email === "string") setEmail(j.email);
      })
      .catch(() => {});
  }, [plan]);

  const go = async () => {
    if (state === "done") return setOpen(true);
    setState("busy");
    try {
      const r = await fetch("/api/account/interest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) });
      if (r.ok) {
        setState("done");
        setOpen(true);
      } else setState("idle");
    } catch {
      setState("idle");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={go}
        disabled={state === "busy"}
        className={cx(
          "inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold transition-colors",
          state === "done" ? (dark ? "bg-ok/15 text-ok hover:bg-ok/25" : "bg-ok/15 text-ink hover:bg-ok/25") : dark ? "bg-chalk text-ink hover:bg-white" : "bg-ink text-chalk hover:bg-ink/85",
          state === "busy" && "opacity-60",
        )}
      >
        {state === "done" ? (
          <>
            <span className="size-1.5 rounded-full bg-ok" /> On the list{email ? "" : " · add email"}
          </>
        ) : state === "busy" ? (
          "Saving…"
        ) : (
          "Tell me when it opens"
        )}
      </button>
      <Confirm open={open} onClose={() => setOpen(false)} planName={planName ?? plan} email={email} onEmail={setEmail} />
    </>
  );
}

function Confirm({ open, onClose, planName, email, onEmail }: { open: boolean; onClose: () => void; planName: string; email: string | null; onEmail: (e: string | null) => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!mounted) return null;

  const save = async () => {
    const v = draft.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return setErr("That doesn't look like an email.");
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/account/interest", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: v }) });
      if (!r.ok) throw new Error();
      onEmail(v);
      setDraft("");
    } catch {
      setErr("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.22 }}
          role="dialog"
          aria-label="Saved"
          className="fixed inset-x-4 bottom-4 z-[80] mx-auto max-w-[440px] rounded-[20px] bg-ink p-5 text-chalk shadow-2xl ring-1 ring-chalk/10"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ok">
                <span className="size-1.5 rounded-full bg-ok" /> Saved
              </div>
              <div className="mt-2 text-[16px] font-semibold tracking-tight">{planName} is on your list.</div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-chalk/60">
                {email ? (
                  <>
                    We&apos;ll email <span className="text-chalk">{email}</span> when it opens. It also shows under Account. No charge, no card.
                  </>
                ) : (
                  <>Saved to this browser&apos;s account; it will show under Account when it opens. Add an email if you want to be told directly. No charge, no card.</>
                )}
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-full text-chalk/50 hover:bg-chalk/10 hover:text-chalk">
              ×
            </button>
          </div>
          {!email && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="mt-4 flex gap-2"
            >
              <input
                type="email"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="h-10 min-w-0 flex-1 rounded-full bg-chalk/[0.06] px-4 text-[13.5px] text-chalk outline-none ring-1 ring-chalk/15 placeholder:text-chalk/30 focus:ring-chalk/40"
              />
              <button type="submit" disabled={busy} className="h-10 shrink-0 rounded-full bg-chalk px-4 text-[13px] font-semibold text-ink hover:bg-white disabled:opacity-60">
                {busy ? "Saving…" : "Notify me"}
              </button>
            </form>
          )}
          {err && <div className="mt-2 text-[12.5px] text-signal">{err}</div>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
