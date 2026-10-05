import { ProtocolWalletCard, TokenCard } from "@/components/economics/ProtocolWallet";
import type { Metadata } from "next";
import Link from "next/link";
import { Hash, Metric, NO_DATA, Panel, PageHead, Shell, SourceBadge, UNKNOWN, pct, sol, usd, when } from "@/components/economy/parts";
import { YourNode } from "@/components/economy/YourNode";
import type { SumCell } from "@/domain/economy";
import { computeUnitListPriceUsd, tokenListPricePer1MUsd } from "@/lib/pricing";
import { cx, fmtInt } from "@/lib/format";
import { listEvents, snapshot } from "@/services/accounting";
import { realSummary } from "@/services/distributed";
import { listEpochsV2 } from "@/services/epochs";
import { listReceipts } from "@/services/receipts";
import { adapterStatuses, syncedTreasury } from "@/services/treasury";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Live economics", description: "Where the money comes from and where it goes, from real accounting events only." };

function Cell({ c, currency = "USD" }: { c: SumCell; currency?: "USD" | "SOL" }) {
  if (c.count === 0) return <>{NO_DATA}</>;
  const f = (x: number) => (currency === "USD" ? usd(x) : `${x.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`);
  return (
    <span>
      {c.settled != null && <span>{f(c.settled)} settled</span>}
      {c.settled != null && c.accrued != null && <span className="text-chalk/35"> · </span>}
      {c.accrued != null && <span className={c.settled == null ? "text-warn" : ""}>{f(c.accrued)} accrued</span>}
    </span>
  );
}

export default async function EconomicsPage() {
  const receipts = await listReceipts(500);
  const [snap, events, treasury, epochs, network] = await Promise.all([snapshot("REAL", 0, undefined, receipts), listEvents("REAL", 30), syncedTreasury(), listEpochsV2(10), realSummary()]);
  const adapters = adapterStatuses();
  const priceCU = computeUnitListPriceUsd();
  const priceTok = tokenListPricePer1MUsd();
  const paidAny = snap.customersPaid.count > 0;

  const flywheel = [
    { k: "Trading", v: adapters.find((a) => a.name === "pumpfun")?.ok ? "connected" : "AWAITING DATA", sub: "Pump.fun creator fees · claims read on-chain" },
    { k: "Creator rewards", v: snap.creatorRewards.count ? <Cell c={snap.creatorRewards} currency="SOL" /> : "AWAITING DATA", sub: `${treasury.received.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL received · ${treasury.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL balance` },
    { k: "Compute subsidy", v: epochs.length ? sol(epochs.reduce((s, e) => s + e.distributedLamports, 0)) : "AWAITING DATA", sub: `${epochs.length} finalized epoch${epochs.length === 1 ? "" : "s"}` },
    { k: "More capacity", v: `${network.realNodes} real nodes`, sub: `${fmtInt(network.capacityScore)} capacity score` },
    { k: "Customer jobs", v: `${receipts.filter((r) => r.customerCost).length} priced / ${receipts.length} receipts`, sub: `${network.jobsCompleted} jobs completed` },
    { k: "Inference revenue", v: paidAny ? <Cell c={snap.customersPaid} /> : "AWAITING DATA", sub: paidAny ? "accrued at list price; nothing collected" : "no priced requests yet" },
    { k: "Network economics", v: snap.networkMargin == null ? "AWAITING DATA" : pct(snap.networkMargin), sub: "margin = (paid + subscriptions − providers − infra) ÷ revenue" },
  ];

  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Live economics <SourceBadge source="REAL" />
          </>
        }
        title="Where the money goes."
        right={
          <Link href="/rewards" className="font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/60 hover:text-chalk">
            Contributor rewards →
          </Link>
        }
      >
        Every figure is a sum over real accounting events on this server. Accrued means owed at a configured list price with no money moved; settled means backed by a transaction reference. Where there is nothing to sum, the cell says so.
      </PageHead>

      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4 lg:grid-cols-7">
        <Metric k="Customers paid" v={<Cell c={snap.customersPaid} />} />
        <Metric k="Compute providers earned" v={<Cell c={snap.providersEarned} />} />
        <Metric k="Creator rewards" v={<Cell c={snap.creatorRewards} currency="SOL" />} />
        <Metric k="Protocol revenue" v={<Cell c={snap.protocolRevenue} />} />
        <Metric k="Infrastructure cost" v={<Cell c={snap.infrastructureCost} />} />
        <Metric k="Network margin" v={pct(snap.networkMargin)} />
        <Metric k="Cost per 1M compute units" v={snap.costPer1MUnits == null ? NO_DATA : usd(snap.costPer1MUnits, 2)} />
      </div>
      <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-7 md:grid-cols-4">
        <Metric k="Subscription revenue" v={<Cell c={snap.subscriptionRevenue} />} sub="no payment processor connected" />
        <Metric k="List price per 1M tokens" v={snap.costPer1MTokens == null ? NO_DATA : usd(snap.costPer1MTokens, 2)} sub={snap.costPer1MTokens == null ? "no priced chat receipts" : "configured list price, applied to real receipts"} />
        <Metric k="Avg customer cost / request" v={snap.avgCostPerJob == null ? NO_DATA : usd(snap.avgCostPerJob)} sub={`${snap.pricedReceipts} priced receipts`} />
        <Metric k="Avg upstream cost / chat" v={snap.avgProviderCostPerChat == null ? NO_DATA : usd(snap.avgProviderCostPerChat)} sub="what the model provider charged BRAIN" />
      </div>

      <Panel className="mt-10" title="Flywheel" right="each stage from a real metric or AWAITING DATA">
        <div className="grid gap-2 md:grid-cols-7">
          {flywheel.map((f, i) => (
            <div key={f.k} className="relative rounded-[10px] bg-ink-2 p-3">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-chalk/45">{f.k}</div>
              <div className={cx("mt-2 font-mono text-[12.5px] leading-snug", typeof f.v === "string" && f.v === "AWAITING DATA" ? "text-chalk/35" : "text-chalk")}>{f.v}</div>
              <div className="mt-1.5 font-mono text-[10px] text-chalk/40">{f.sub}</div>
              {i < flywheel.length - 1 && <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-chalk/25 md:block">→</span>}
            </div>
          ))}
        </div>
      </Panel>

      <div className="mt-5">
        <YourNode />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <TokenCard />
        <ProtocolWalletCard />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel title="Creator-reward treasury" right={`${treasury.adapter} adapter`}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Metric k="Balance" v={`${treasury.balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`} />
            <Metric k="Received" v={`${treasury.received.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`} />
            <Metric k="Allocated" v={`${treasury.allocated.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`} />
            <Metric k="Pending distribution" v={`${treasury.pendingDistribution.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`} />
          </div>
          <ul className="mt-4 space-y-1 font-mono text-[11px]">
            {adapters.map((a) => (
              <li key={a.name} className="flex justify-between gap-3 border-b border-chalk/[0.07] py-1">
                <span className="text-chalk/70">
                  {a.name} <span className="text-chalk/35">· {a.source}</span>
                </span>
                <span className={a.ok ? "text-ok" : "text-chalk/40"}>{a.ok ? "ready" : "off"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11.5px] text-chalk/45">{adapters.find((a) => a.name === "pumpfun")?.detail}</p>
        </Panel>

        <Panel title="Pricing configuration" right="operator">
          <div className="space-y-3 font-mono text-[12px]">
            <div className="flex justify-between border-b border-chalk/[0.07] py-1">
              <span className="text-chalk/55">Per 1,000 compute units</span>
              <span>{priceCU == null ? UNKNOWN : usd(priceCU)}</span>
            </div>
            <div className="flex justify-between border-b border-chalk/[0.07] py-1">
              <span className="text-chalk/55">Per 1M chat tokens</span>
              <span>{priceTok == null ? UNKNOWN : usd(priceTok)}</span>
            </div>
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-chalk/45">Unset prices mean receipts carry no cost and no accounting events are created. Set BRAIN_PRICE_USD_PER_1K_COMPUTE_UNITS / BRAIN_PRICE_USD_PER_1M_TOKENS to start accruing.</p>
        </Panel>

        <Panel title="Reward epochs (v2)" right={`${epochs.length}`}>
          {epochs.length === 0 ? (
            <div className="font-mono text-[12px] text-chalk/45">No epoch has been finalized on this server. POST /api/epochs with BRAIN_ADMIN_TOKEN after an epoch closes.</div>
          ) : (
            <ul className="space-y-1 font-mono text-[12px]">
              {epochs.map((e) => (
                <li key={e.epochId} className="flex justify-between gap-3 border-b border-chalk/[0.07] py-1.5">
                  <Link href={`/epoch/${e.epochId}`} className="text-chalk hover:underline">
                    {e.epochId}
                  </Link>
                  <span className="text-chalk/60">
                    {sol(e.distributedLamports)} · {e.participants} nodes
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="mt-5" title="Accounting events" right={`${snap.events} total · newest first`}>
        {events.length === 0 ? (
          <div className="font-mono text-[12px] text-chalk/45">No real accounting events yet. They are created when a priced receipt is issued or a creator-reward receipt is recorded.</div>
        ) : (
          <div className="grid gap-1 font-mono text-[11.5px]">
            {events.map((e) => (
              <div key={e.id} className="grid grid-cols-[150px_1fr_auto_auto] items-center gap-3 rounded-[6px] px-3 py-1.5 odd:bg-chalk/[0.03]">
                <span className="text-chalk/40">{when(e.timestamp)}</span>
                <span className="truncate">
                  <span className="text-chalk">{e.type}</span>
                  {e.relatedReceiptId && (
                    <Link href={`/receipt/${e.relatedReceiptId}`} className="ml-2 text-chalk/50 hover:text-chalk">
                      {e.relatedReceiptId}
                    </Link>
                  )}
                  {e.relatedNodeId && <span className="ml-2 text-chalk/40">node {e.relatedNodeId}</span>}
                </span>
                <span className={e.settlement === "settled" ? "text-ok" : "text-warn"}>{e.settlement}</span>
                <span className="text-chalk">{e.currency === "USD" ? usd(e.amount, 6) : `${e.amount} SOL`}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {receipts[0] && (
        <div className="mt-6">
          <Hash label="Latest receipt hash" value={`${receipts[0].receiptId} · ${receipts[0].resultHash}`} />
        </div>
      )}
    </Shell>
  );
}
