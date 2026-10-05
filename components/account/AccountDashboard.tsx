"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Metric, NO_DATA, Panel, SourceBadge, usd, when } from "@/components/economy/parts";
import { WalletButton } from "@/components/wallet/WalletButton";
import { useWallet } from "@/lib/wallet/store";
import { cx, shortAddr } from "@/lib/format";
import type { AccountSummary } from "@/services/accountSummary";
import type { CreditEvent } from "@/services/credits";

/**
 * YOUR PLAN · SUBSCRIPTION · COMPUTE EARNINGS · NET. Everything shown is REAL (accrued ledger
 * lines); nothing is projected. Missing data says so.
 */
export function AccountDashboard() {
  const [s, setS] = useState<AccountSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const w = useWallet();

  const refresh = useCallback(() => {
    fetch("/api/account", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => (j.summary ? setS(j.summary) : setErr("Could not load account.")))
      .catch(() => setErr("Server unreachable."));
  }, []);
  useEffect(refresh, [refresh]);
  // After a wallet is verified in this tab, the server has attached it; reload the summary.
  useEffect(() => {
    if (w.status === "connected" && w.verified) refresh();
  }, [w.status, w.verified, refresh]);

  if (err) return <div className="mt-10 font-mono text-[12.5px] text-signal">{err}</div>;
  if (!s) return <div className="mt-10 font-mono text-[12px] text-chalk/40">Loading account…</div>;

  const c = s.credits;
  const usageUsd = s.usage.cost;
  const earned = s.compute.earnedUsd;
  return (
    <div className="mt-10 space-y-5">
      <div className="grid gap-5 lg:grid-cols-4">
        <Panel title="Your plan" right={<SourceBadge source="REAL" />}>
          <Metric k="Plan" v={s.plan.name} sub={s.plan.priceUsd === 0 ? "free" : s.plan.placeholder ? `$${s.plan.priceUsd}/mo · placeholder` : `$${s.plan.priceUsd}/mo`} />
          <div className="mt-5 font-mono text-[11px] text-chalk/50">
            {s.plan.includedCredits.toLocaleString("en-US")} credits / month · {s.plan.rateLimit} req/min
            <br />
            modes {s.plan.modes.filter((m) => m !== "BROWSER_ONLY").join(" · ")}
          </div>
          <Link href="/pricing" className="mt-4 inline-block font-mono text-[11.5px] text-chalk/70 underline decoration-chalk/25 underline-offset-4 hover:text-chalk">
            Plans →
          </Link>
        </Panel>
        <Panel title="Subscription" right={<SourceBadge source="REAL" />}>
          <Metric k="Paid this month" v={s.paymentsConnected ? usd(0) : "$0"} sub={s.paymentsConnected ? "settled payments" : "payments not connected; nothing has been charged"} />
          <div className="mt-5 grid grid-cols-2 gap-4">
            <Metric k="Credits left" v={Math.max(0, Math.floor(c.balance)).toLocaleString("en-US")} sub={`of ${Math.floor(c.granted).toLocaleString("en-US")} granted`} />
            <Metric k="Used" v={usageUsd == null ? (s.usage.requests ? "UNKNOWN" : "$0") : usd(usageUsd)} sub={`${s.usage.requests} request${s.usage.requests === 1 ? "" : "s"}${c.unknownCostRequests ? ` · ${c.unknownCostRequests} unpriced` : ""}`} />
          </div>
        </Panel>
        <Panel title="Compute earnings" right={<SourceBadge source="REAL" />}>
          {s.compute.wallet ? (
            <>
              <Metric k="Earned (accrued)" v={earned == null ? NO_DATA : usd(earned)} sub={`${s.compute.nodeIds.length} node${s.compute.nodeIds.length === 1 ? "" : "s"} · ${s.compute.nodesOnline} online`} tone={earned ? "ok" : undefined} />
              <div className="mt-5 font-mono text-[11px] text-chalk/50">
                wallet {shortAddr(s.compute.wallet)}
                <br />
                {Math.floor(c.offset).toLocaleString("en-US")} credits mirrored as offset
              </div>
            </>
          ) : (
            <>
              <Metric k="Earned (accrued)" v={<span className="text-chalk/35">—</span>} sub="no wallet attached" />
              <p className="mt-4 text-[12.5px] leading-relaxed text-chalk/55">Attach the wallet you contribute with. Earnings from nodes it powers offset your usage.</p>
              <div className="mt-4">
                <WalletButton dark />
              </div>
            </>
          )}
        </Panel>
        <Panel title="Net" right={<SourceBadge source="REAL" />}>
          <Metric k="Earned − used" v={s.netUsd == null ? NO_DATA : usd(s.netUsd)} tone={s.netUsd == null ? "muted" : s.netUsd >= 0 ? "ok" : undefined} big sub={s.netUsd == null ? (s.compute.wallet ? "a side is UNKNOWN" : "attach a wallet to compute") : s.netUsd >= 0 ? "your compute covers your usage" : "usage exceeds compute earned"} />
          <p className="mt-4 text-[11.5px] leading-relaxed text-chalk/45">Ledger primitive: nothing is paid out and nothing is charged. Figures are accrued at list price from REAL receipts.</p>
        </Panel>
      </div>

      <Panel title="Credit ledger" right={`${c.events.length} entries`}>
        {c.events.length === 0 ? (
          <div className="font-mono text-[12px] text-chalk/40">No entries yet.</div>
        ) : (
          <div className="font-mono text-[11.5px]">
            <div className="grid grid-cols-[150px_110px_1fr_90px] gap-3 border-b border-chalk/10 pb-2 text-[9.5px] uppercase tracking-[0.14em] text-chalk/40 max-md:hidden">
              <span>When</span>
              <span>Type</span>
              <span>Detail</span>
              <span className="text-right">Credits</span>
            </div>
            {c.events.slice(0, 60).map((e) => (
              <LedgerRow key={e.id} e={e} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="API keys" right={<SourceBadge source="REAL" />}>
        <p className="text-[13px] leading-relaxed text-chalk/60">
          Programmatic access uses the OpenAI-compatible API with a key. Keys and usage are managed under <Link href="/developers" className="text-chalk underline decoration-chalk/25 underline-offset-4">Developers</Link>; linking keys to this account lands with billing.
        </p>
      </Panel>
    </div>
  );
}

function LedgerRow({ e }: { e: CreditEvent }) {
  const label = e.type === "GRANT_INCLUDED" ? "GRANT" : e.type === "COMPUTE_OFFSET" ? "COMPUTE" : e.type;
  const detail =
    e.type === "CONSUME"
      ? `${e.detail?.route?.target ?? "—"} · ${e.detail?.model ?? "—"} · ${e.costUnknown ? "cost UNKNOWN" : usd(e.usd)}${e.detail?.receiptId ? "" : ""}`
      : e.type === "GRANT_INCLUDED"
        ? `${e.period} included credits`
        : e.type === "COMPUTE_OFFSET"
          ? `node ${e.detail?.nodeId ?? "—"} earned ${usd(e.usd)}`
          : "";
  return (
    <div className="grid grid-cols-[150px_110px_1fr_90px] items-center gap-3 border-b border-chalk/[0.06] py-2 text-chalk/75 max-md:grid-cols-[1fr_80px]">
      <span className="text-chalk/45 max-md:hidden">{when(e.at)}</span>
      <span className={cx(e.type === "CONSUME" ? "text-chalk/70" : "text-ok")}>{label}</span>
      <span className="truncate max-md:col-span-2 max-md:order-last">
        {detail}
        {e.detail?.receiptId && (
          <>
            {" "}
            <Link href={`/receipt/${e.detail.receiptId}`} className="text-chalk/50 underline decoration-chalk/20 underline-offset-4 hover:text-chalk">
              receipt
            </Link>
          </>
        )}
      </span>
      <span className={cx("num text-right", e.credits < 0 ? "text-chalk" : "text-ok")}>{e.costUnknown ? "?" : `${e.credits > 0 ? "+" : ""}${Math.abs(e.credits) < 0.01 && e.credits !== 0 ? e.credits.toFixed(4) : e.credits.toFixed(2)}`}</span>
    </div>
  );
}
