"use client";

import { useEffect, useState } from "react";
import { Prov } from "@/components/ui";
import { accountUrl, protocolWallet, txUrl } from "@/lib/site";
import { cx, shortAddr } from "@/lib/format";
import type { ProtocolWalletView } from "@/services/protocolWallet";

const sol = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;

/**
 * The protocol wallet, read from chain. Creator fees from the token land here and fund the
 * contributor pool. Balance and transfers are LIVE; if the RPC is unreachable the figure says
 * UNKNOWN. Transfers are not labelled as creator fees until an operator confirms the signature.
 */
export function ProtocolWalletCard({ className, tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const [v, setV] = useState<ProtocolWalletView | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/treasury/wallet", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: ProtocolWalletView | null) => !stop && j && setV(j))
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  const dark = tone === "dark";
  const muted = dark ? "text-chalk/50" : "text-ink/50";
  const inbound = v?.recent.filter((t) => t.deltaSol > 0) ?? [];
  return (
    <div className={cx("rounded-[20px] p-6 ring-1 md:p-7", dark ? "bg-ink-2 text-chalk ring-chalk/[0.08]" : "bg-paper text-ink ring-ink/10", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className={cx("label flex items-center gap-2", muted)}>
            Protocol wallet <Prov p="live" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[13px]">
            <a href={accountUrl(protocolWallet.address)} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline" title={protocolWallet.address}>
              <span className="sm:hidden">{shortAddr(protocolWallet.address)}</span>
              <span className="hidden sm:inline">{protocolWallet.address}</span>
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(protocolWallet.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
              className={cx("rounded-full px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] ring-1 ring-inset", dark ? "text-chalk/60 ring-chalk/20 hover:text-chalk" : "text-ink/60 ring-ink/20 hover:text-ink")}
            >
              {copied ? "copied" : "copy"}
            </button>
            <a href={accountUrl(protocolWallet.address)} target="_blank" rel="noreferrer" className={cx("text-[11px]", muted, "hover:underline")}>
              Solscan ↗
            </a>
          </div>
          <p className={cx("mt-3 max-w-[560px] text-[13.5px] leading-relaxed", muted)}>
            Creator fees from the token are claimed to this address and fund the contributor pool. The server never holds its key. Transfers below are raw on-chain activity; a transfer only counts as creator revenue
            once its signature is recorded in the ledger.
          </p>
        </div>
        <div className="text-right">
          <div className={cx("label", muted)}>Balance</div>
          <div className="num mt-1 text-[28px] font-medium leading-none md:text-[34px]">
            {v == null ? <span className="opacity-40">…</span> : v.balanceSol == null ? <span className={cx("font-mono text-[14px] uppercase tracking-[0.08em]", muted)}>Unknown</span> : sol(v.balanceSol)}
          </div>
          <div className={cx("mt-1.5 font-mono text-[10.5px]", muted)}>{v?.balanceSol == null ? (v ? "RPC unreachable" : "") : `on-chain · ${v.cluster}`}</div>
        </div>
      </div>
      {v && v.balanceSol != null && (
        <div className={cx("mt-5 border-t pt-4 font-mono text-[12px]", dark ? "border-chalk/10" : "border-ink/10")}>
          {inbound.length === 0 ? (
            <div className={muted}>No inbound transfers in the last {v.recent.length || 8} transactions.</div>
          ) : (
            <ul className="space-y-1.5">
              {inbound.slice(0, 5).map((t) => (
                <li key={t.signature} className="flex items-center justify-between gap-4">
                  <a href={txUrl(t.signature, v.cluster)} target="_blank" rel="noreferrer" className={cx("truncate hover:underline", muted)}>
                    {t.signature.slice(0, 10)}…{t.signature.slice(-6)}
                  </a>
                  <span className={muted}>{t.at ? new Date(t.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span>
                  <span className="text-ok">+{sol(t.deltaSol)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
