"use client";

import { useEffect, useState } from "react";
import { Prov } from "@/components/ui";
import { accountUrl, protocolWallet, pumpUrl, token, tokenUrl, txUrl } from "@/lib/site";
import { cx, shortAddr } from "@/lib/format";
import type { ProtocolWalletView, TokenStatus } from "@/services/protocolWallet";

const sol = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`;

/**
 * The protocol wallet, read from chain. Creator fees from the token land here and fund the
 * contributor pool. Balance and transfers are LIVE; if the RPC is unreachable the figure says
 * UNKNOWN. A transfer is labelled a creator fee only when the chain shows SOL leaving one of our
 * pump.fun creator-fee vaults into this wallet in the same transaction; unclaimed fees still in
 * the vault are shown separately and are not revenue yet.
 */
export function ProtocolWalletCard({ className, tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const [v, setV] = useState<ProtocolWalletView | null>(null);
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
            <CopyButton text={protocolWallet.address} dark={dark} />
            <a href={accountUrl(protocolWallet.address)} target="_blank" rel="noreferrer" className={cx("text-[11px]", muted, "hover:underline")}>
              Solscan ↗
            </a>
          </div>
          <p className={cx("mt-3 max-w-[560px] text-[13.5px] leading-relaxed", muted)}>
            Creator fees from the token accrue in pump.fun&apos;s vault and are claimed to this address. The server never holds its key. Each claim is read from chain by signature and funds the contributor pool at
            the published split; claims are paid from a separate payout wallet. Other inbound transfers are shown but do not count as creator revenue.
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
      {v && (
        <div className={cx("mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4 font-mono text-[12px]", dark ? "border-chalk/10" : "border-ink/10")}>
          <span className="flex flex-wrap items-center gap-2">
            <span className={muted}>Unclaimed creator fees</span>
            <a href={accountUrl(v.creatorVault.bonding.address, v.cluster)} target="_blank" rel="noreferrer" className={cx("hover:underline", muted)} title={v.creatorVault.bonding.address}>
              vault ↗
            </a>
            <span className={cx("rounded-sm px-1 text-[9.5px] uppercase tracking-[0.08em] ring-1", muted, dark ? "ring-chalk/20" : "ring-ink/20")}>not revenue until claimed</span>
          </span>
          <span>{v.creatorVault.totalSol == null ? <span className={muted}>UNKNOWN</span> : sol(v.creatorVault.totalSol)}</span>
        </div>
      )}
      {v?.payout && (
        <div className={cx("mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-4 font-mono text-[12px]", dark ? "border-chalk/10" : "border-ink/10")}>
          <span className="flex flex-wrap items-center gap-2">
            <span className={muted}>Payout wallet</span>
            <a href={accountUrl(v.payout.address, v.cluster)} target="_blank" rel="noreferrer" className="hover:underline" title={v.payout.address}>
              {shortAddr(v.payout.address)}
            </a>
            <CopyButton text={v.payout.address} dark={dark} />
            <span className={cx("rounded-sm px-1 text-[9.5px] uppercase tracking-[0.08em] ring-1", v.payout.enabled ? "text-ok ring-ok/40" : "text-warn ring-warn/40")}>{v.payout.enabled ? "claims open" : v.payout.opensAt ? <Countdown at={v.payout.opensAt} prefix="claims open in" /> : "claims off"}</span>
          </span>
          <span>{v.payout.balanceSol == null ? <span className={muted}>UNKNOWN</span> : sol(v.payout.balanceSol)}</span>
        </div>
      )}
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
                  <span className={cx("rounded-sm px-1 text-[9.5px] uppercase tracking-[0.08em] ring-1", t.creatorFeeSol > 0 ? "text-ok ring-ok/40" : cx(muted, dark ? "ring-chalk/20" : "ring-ink/20"))}>
                    {t.creatorFeeSol > 0 ? "creator fee" : "transfer"}
                  </span>
                  <span className={muted}>{t.at ? new Date(t.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}</span>
                  <span className={t.creatorFeeSol > 0 ? "text-ok" : ""}>+{sol(t.deltaSol)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared loader so the token card and the footer line hit one cached endpoint. */
export function useTokenStatus(): TokenStatus | null {
  const [t, setT] = useState<TokenStatus | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/treasury/wallet", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: ProtocolWalletView | null) => !stop && j && setT(j.token))
        .catch(() => {});
    void load();
    const i = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(i);
    };
  }, []);
  return t;
}

export function CopyButton({ text, dark }: { text: string; dark: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cx("rounded-full px-2 py-0.5 text-[10.5px] uppercase tracking-[0.1em] ring-1 ring-inset", dark ? "text-chalk/60 ring-chalk/20 hover:text-chalk" : "text-ink/60 ring-ink/20 hover:text-ink")}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * The token: fixed contract address, live/not-live read from chain. No price, no market cap,
 * no holder count: none of those come from a source this server trusts.
 */
export function TokenCard({ className, tone = "dark" }: { className?: string; tone?: "dark" | "light" }) {
  const t = useTokenStatus();
  const dark = tone === "dark";
  const muted = dark ? "text-chalk/50" : "text-ink/50";
  const live = t?.live === true;
  return (
    <div className={cx("rounded-[20px] p-6 ring-1 md:p-7", dark ? "bg-ink-2 text-chalk ring-chalk/[0.08]" : "bg-paper text-ink ring-ink/10", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className={cx("label flex items-center gap-2", muted)}>
            Token · {token.symbol} <Prov p="live" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[13px]">
            <span className="break-all" title={token.mint}>
              <span className="sm:hidden">{shortAddr(token.mint)}</span>
              <span className="hidden sm:inline">{token.mint}</span>
            </span>
            <CopyButton text={token.mint} dark={dark} />
            {live && (
              <>
                <a href={pumpUrl()} target="_blank" rel="noreferrer" className={cx("text-[11px]", muted, "hover:underline")}>
                  {token.launchpad} ↗
                </a>
                <a href={tokenUrl()} target="_blank" rel="noreferrer" className={cx("text-[11px]", muted, "hover:underline")}>
                  Solscan ↗
                </a>
              </>
            )}
          </div>
          <p className={cx("mt-3 max-w-[560px] text-[13.5px] leading-relaxed", muted)}>
            {live
              ? "Creator fees from trading go to the protocol wallet and fund the contributor pool. Holding raises the multiplier on verified compute, up to a cap. Holding alone earns nothing."
              : t == null || t.live == null
                ? "This is the contract address. The site reads the mint from the chain; its status appears here once that read completes."
                : "This is the contract address. It is not live yet; the site checks the chain and flips this card the moment the mint exists. Anything else using this address before then is not us."}
          </p>
        </div>
        <div className="text-right">
          <div className={cx("label", muted)}>Status</div>
          <div className={cx("num mt-1 font-mono text-[18px] font-semibold uppercase tracking-[0.06em] md:text-[22px]", live ? "text-ok" : t == null || t.live == null ? muted : "text-warn")}>
            {t == null ? "…" : t.live == null ? "Unknown" : live ? "Live" : "Not live yet"}
          </div>
          <div className={cx("mt-1.5 font-mono text-[10.5px]", muted)}>{t == null ? "" : t.live == null ? "RPC unreachable" : live && t.supply != null ? `${t.supply.toLocaleString("en-US", { maximumFractionDigits: 0 })} supply · on-chain` : "checked on-chain"}</div>
        </div>
      </div>
    </div>
  );
}

/** One-line contract address for the footer: address, copy, and the on-chain status. */
export function ContractLine({ className }: { className?: string }) {
  const t = useTokenStatus();
  const live = t?.live === true;
  return (
    <div className={cx("inline-flex max-w-full flex-wrap items-center gap-2 rounded-full border border-chalk/10 bg-chalk/[0.03] px-4 py-2 font-mono text-[11.5px] text-chalk/60", className)}>
      <span className="text-chalk/40">CA</span>
      <span className="truncate" title={token.mint}>
        {shortAddr(token.mint)}
      </span>
      <CopyButton text={token.mint} dark />
      <span className={cx("rounded-sm px-1 text-[9.5px] uppercase tracking-[0.08em] ring-1", live ? "text-ok ring-ok/40" : t?.live == null ? "text-chalk/40 ring-chalk/20" : "text-warn ring-warn/40")}>
        {t == null ? "…" : t.live == null ? "unknown" : live ? "live" : "not live yet"}
      </span>
      {live && (
        <a href={pumpUrl()} target="_blank" rel="noreferrer" className="hover:text-chalk">
          {token.launchpad} ↗
        </a>
      )}
    </div>
  );
}

/** Live countdown; re-renders every 30 s. Falls back to the wall-clock time once under a minute. */
export function Countdown({ at, prefix }: { at: number; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const ms = at - now;
  if (ms <= 0) return <>{prefix ? "claims open" : "now"}</>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return <>{prefix ? `${prefix} ` : ""}{h > 0 ? `${h}h ` : ""}{m}m</>;
}
