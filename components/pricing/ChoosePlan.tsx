"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { WalletButton } from "@/components/wallet/WalletButton";
import { cx, fmtInt, shortAddr } from "@/lib/format";
import { txUrl } from "@/lib/site";
import { useWallet, walletStore } from "@/lib/wallet/store";
import type { AccountSummary } from "@/services/accountSummary";
import type { PaymentIntent } from "@/services/payments";

type Currency = "SOL" | "USDC";
type Quotes = { enabled: boolean; solUsd: { usd: number; source: string } | null; plans: { plan: string; usd: number | null; usdc: number; sol: number | null }[] };

/**
 * Buy or extend a paid plan. The server builds the exact transfer; the wallet signs and sends it;
 * the server reads it back from the chain before anything changes. Every state the buyer can be in
 * is spelled out, including "sent but not confirmed yet", which is normal for a few seconds.
 */
export function ChoosePlan({ plan, planName, priceUsd, holdTokens, dark }: { plan: string; planName: string; priceUsd: number; holdTokens: number | null; dark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const refresh = useCallback(() => {
    fetch("/api/account", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => j.summary && setSummary(j.summary))
      .catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const st = summary?.status;
  const current = st?.plan.id === plan;
  const label = current && st?.basis === "paid" ? `Extend ${planName} · 30 days` : current && st?.basis === "holder" ? `${planName} · included for holders` : `Choose ${planName}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx("inline-flex h-11 w-full items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold transition-colors", dark ? "bg-chalk text-ink hover:bg-white" : "bg-ink text-chalk hover:bg-ink/85")}
      >
        {label}
      </button>
      {holdTokens != null && <div className={cx("mt-2 text-center font-mono text-[10.5px]", dark ? "text-chalk/45" : "text-fog")}>or hold {fmtInt(holdTokens)} BRAIN · included while you hold</div>}
      <PayPanel open={open} onClose={() => setOpen(false)} plan={plan} planName={planName} priceUsd={priceUsd} holdTokens={holdTokens} summary={summary} onChanged={refresh} />
    </>
  );
}

type Step = "idle" | "building" | "signing" | "confirming" | "done" | "error";

function PayPanel({ open, onClose, plan, planName, priceUsd, holdTokens, summary, onChanged }: { open: boolean; onClose: () => void; plan: string; planName: string; priceUsd: number; holdTokens: number | null; summary: AccountSummary | null; onChanged: () => void }) {
  const w = useWallet();
  const [mounted, setMounted] = useState(false);
  const [quotes, setQuotes] = useState<Quotes | null>(null);
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentIntent | null>(null);
  const [holder, setHolder] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    fetch("/api/account/pay", { cache: "no-store" })
      .then((r) => r.json())
      .then(setQuotes)
      .catch(() => {});
    const k = (e: KeyboardEvent) => e.key === "Escape" && step !== "signing" && step !== "confirming" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose, step]);
  if (!mounted) return null;

  const q = quotes?.plans.find((p) => p.plan === plan);
  const connected = w.status === "connected" && w.verified && w.address;
  const amount = currency === "USDC" ? q?.usdc : q?.sol;
  const canPay = connected && quotes?.enabled && amount != null && step !== "building" && step !== "signing" && step !== "confirming";

  const pay = async () => {
    if (!connected || !w.address) return;
    setErr(null);
    setStep("building");
    try {
      const r = await fetch("/api/account/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan, currency, payer: w.address }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not start the purchase.");
      const intent: PaymentIntent = j.intent;
      setStep("signing");
      const signature = await walletStore.payTransaction(j.transactionBase64);
      setStep("confirming");
      // The transaction needs a few seconds to confirm; keep asking until the server has read it.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const c = await fetch("/api/account/pay", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ intentId: intent.id, signature }) });
        const cj = await c.json();
        if (c.ok) {
          setPayment(cj.payment);
          setStep("done");
          onChanged();
          return;
        }
        if (cj.error?.code !== "tx_not_found" || Date.now() > deadline) {
          throw new Error(cj.error?.code === "tx_not_found" ? `Sent, but not confirmed yet. Signature ${signature.slice(0, 12)}…; your plan activates once it confirms — reopen this panel to retry.` : (cj.error?.message ?? "Could not confirm the payment."));
        }
        await new Promise((res) => setTimeout(res, 2500));
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(/reject|declin|denied|cancel/i.test(m) ? "Declined in your wallet. Nothing was sent." : m);
      setStep("error");
    }
  };

  const checkHolder = async () => {
    setHolder({ busy: true, msg: null });
    try {
      const r = await fetch("/api/account/holder", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message ?? "Could not check holdings.");
      const bal = typeof j.balance === "number" ? fmtInt(j.balance) : "unknown";
      setHolder({ busy: false, msg: j.unlocks ? `Wallet holds ${bal} BRAIN → ${j.unlocks} unlocked while you hold.` : `Wallet holds ${bal} BRAIN. ${fmtInt(holdTokens ?? 0)} needed for ${planName}.` });
      onChanged();
    } catch (e) {
      setHolder({ busy: false, msg: e instanceof Error ? e.message : "Could not check holdings." });
    }
  };

  const busy = step === "building" || step === "signing" || step === "confirming";
  const st = summary?.status;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[79] bg-black/60" onClick={() => !busy && onClose()} />
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22 }}
            role="dialog"
            aria-label={`Choose ${planName}`}
            className="fixed inset-x-4 bottom-4 z-[80] mx-auto max-w-[480px] rounded-[20px] bg-ink p-5 text-chalk shadow-2xl ring-1 ring-chalk/10 md:bottom-auto md:top-1/2 md:-translate-y-1/2"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-chalk/50">{planName} · ${priceUsd} / 30 days</div>
                <div className="mt-2 text-[18px] font-semibold tracking-tight">{step === "done" ? `${planName} is active.` : st?.plan.id === plan && st?.basis === "paid" ? "Add 30 days." : `Pay on Solana.`}</div>
              </div>
              {!busy && (
                <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 shrink-0 place-items-center rounded-full text-chalk/50 hover:bg-chalk/10 hover:text-chalk">
                  ×
                </button>
              )}
            </div>

            {step === "done" && payment ? (
              <div className="mt-4 space-y-3 text-[13.5px] leading-relaxed text-chalk/70">
                <p>
                  Paid {payment.amount} {payment.currency} ({`$${payment.amountUsd}`}) to the protocol wallet. {fmtInt(summary?.plan.includedCredits ?? 0)} credits are on your account{st?.until ? `; the plan runs until ${new Date(st.until).toISOString().slice(0, 10)}` : ""}.
                </p>
                <p className="font-mono text-[11px] text-chalk/45">
                  {payment.signature && (
                    <a href={txUrl(payment.signature)} target="_blank" rel="noreferrer" className="underline decoration-chalk/25 underline-offset-4 hover:text-chalk">
                      transaction {payment.signature.slice(0, 8)}… ↗
                    </a>
                  )}
                </p>
                <div className="flex gap-2 pt-1">
                  <Link href="/account" className="inline-flex h-10 items-center rounded-full bg-chalk px-4 text-[13px] font-semibold text-ink hover:bg-white">
                    Account →
                  </Link>
                  <Link href="/chat" className="inline-flex h-10 items-center rounded-full px-4 text-[13px] font-semibold text-chalk/80 ring-1 ring-inset ring-chalk/20 hover:ring-chalk/50">
                    Chat
                  </Link>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {(["USDC", "SOL"] as Currency[]).map((c) => {
                    const amt = c === "USDC" ? q?.usdc : q?.sol;
                    const off = c === "SOL" && quotes != null && q?.sol == null;
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={busy || off}
                        onClick={() => setCurrency(c)}
                        className={cx("rounded-[12px] px-4 py-3 text-left ring-1 ring-inset transition-colors", currency === c ? "bg-chalk/10 ring-chalk/50" : "ring-chalk/15 hover:ring-chalk/35", off && "opacity-40")}
                      >
                        <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-chalk/50">{c}</div>
                        <div className="num mt-1 text-[18px]">{amt == null ? (off ? "no price" : "…") : c === "USDC" ? amt.toFixed(2) : amt.toFixed(4)}</div>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-chalk/40">
                  {currency === "SOL" && quotes?.solUsd ? `SOL at $${quotes.solUsd.usd.toFixed(2)} (${quotes.solUsd.source}), quote held 20 minutes. ` : currency === "USDC" ? "USDC 1:1 with the USD price. " : ""}
                  Goes to the protocol wallet, which funds contributor payouts. Verified on chain before the plan activates.
                </p>

                <div className="mt-4">
                  {connected ? (
                    <button type="button" onClick={pay} disabled={!canPay} className="inline-flex h-11 w-full items-center justify-center rounded-full bg-chalk px-5 text-[14px] font-semibold text-ink hover:bg-white disabled:opacity-60">
                      {step === "building" ? "Preparing…" : step === "signing" ? "Confirm in your wallet…" : step === "confirming" ? "Waiting for the chain…" : `Pay ${amount == null ? "" : currency === "USDC" ? `${amount.toFixed(2)} USDC` : `${amount.toFixed(4)} SOL`} from ${shortAddr(w.address!)}`}
                    </button>
                  ) : (
                    <div>
                      <div className="mb-2 font-mono text-[11px] text-chalk/50">Connect the wallet that pays. It is proven by signature first; the payment is a second step.</div>
                      <WalletButton dark className="w-full" />
                    </div>
                  )}
                </div>
                {err && <div className="mt-3 text-[12.5px] leading-relaxed text-signal">{err}</div>}

                {holdTokens != null && (
                  <div className="mt-5 border-t border-chalk/10 pt-4">
                    <div className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-chalk/50">Or hold the token</div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-chalk/65">
                      A linked wallet holding at least {fmtInt(holdTokens)} BRAIN has {planName} included while it holds. Nothing is locked or spent; the balance is re-read from the chain every few hours.
                    </p>
                    <div className="mt-3 flex items-center gap-3">
                      <button type="button" onClick={checkHolder} disabled={!connected || holder.busy} className="inline-flex h-9 items-center rounded-full px-4 text-[12.5px] font-semibold text-chalk ring-1 ring-inset ring-chalk/25 hover:ring-chalk/55 disabled:opacity-50">
                        {holder.busy ? "Reading chain…" : "Check my holdings"}
                      </button>
                      {!connected && <span className="font-mono text-[10.5px] text-chalk/40">connect first</span>}
                    </div>
                    {holder.msg && <div className="mt-2 text-[12.5px] text-chalk/75">{holder.msg}</div>}
                  </div>
                )}
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
