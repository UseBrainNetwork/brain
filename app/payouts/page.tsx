import type { Metadata } from "next";
import Link from "next/link";
import { Metric, NO_DATA, Panel, PageHead, Shell, SourceBadge, when } from "@/components/economy/parts";
import { DailyPaid, EpochBars } from "@/components/payouts/PayoutCharts";
import { Button } from "@/components/ui";
import { cx, fmtInt, shortAddr } from "@/lib/format";
import { accountUrl, protocolWallet, txUrl } from "@/lib/site";
import { isStoreUnavailable, isTransientDbError } from "@/services/failsoft";
import { payoutsData, type PayoutsData } from "@/services/payoutsPage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Payouts",
  description: "Every SOL payout BRAIN has sent to contributor wallets, with the transaction for each one.",
};

const sol = (lamports: number, digits = 4) => (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: digits });

export default async function PayoutsPage() {
  let d: PayoutsData | null = null;
  try {
    d = await payoutsData();
  } catch (e) {
    if (!isStoreUnavailable(e) && !isTransientDbError(e)) throw e;
  }
  if (!d) {
    return (
      <Shell>
        <PageHead eyebrow={<>Rewards · Payouts</>} title="Paid out.">
          The database is not answering right now, so this page cannot show its numbers. Nothing is estimated in its place.
        </PageHead>
        <Link href="/payouts" className="mt-8 inline-block font-mono text-[12px] text-chalk underline decoration-chalk/30 underline-offset-4">
          Retry →
        </Link>
      </Shell>
    );
  }

  const paidSol = d.totals.lamports / 1e9;
  const usd = d.quote ? paidSol * d.quote.usd : null;
  const unclaimed = Math.max(0, d.allocatedLamports - d.totals.lamports);
  const latest = d.epochs[0] ?? null;

  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Rewards · Payouts <SourceBadge source="REAL" />
          </>
        }
        title="Paid out."
        right={
          <div className="flex flex-wrap gap-3">
            <Button href="/rewards#claim" tone="dark" arrow>
              Claim yours
            </Button>
            <Button href={accountUrl(protocolWallet.address)} tone="dark" variant="secondary">
              Payout wallet ↗
            </Button>
          </div>
        }
      >
        SOL that has left the payout wallet and landed in contributor wallets. Every row below is a transaction on Solana you can open; every epoch is one that settled. If a number is not here, it has not happened.
      </PageHead>

      {/* Headline */}
      <div className="mt-10 grid gap-px overflow-hidden rounded-[18px] bg-chalk/10 md:grid-cols-[1.6fr_1fr_1fr]">
        <div className="bg-ink p-7 md:p-9">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-chalk/45">Paid to contributors · all time</div>
          <div className="num mt-4 text-[clamp(56px,9vw,120px)] leading-[0.95] text-ok">
            {sol(d.totals.lamports, 3)}
            <span className="ml-3 align-baseline font-mono text-[18px] tracking-normal text-chalk/50 md:text-[24px]">SOL</span>
          </div>
          <div className="mt-4 font-mono text-[11.5px] text-chalk/50">
            {usd != null ? (
              <>
                ≈ ${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })} at today&apos;s SOL price ({d.quote!.source}); the SOL was paid at the time of each claim
              </>
            ) : (
              <>USD value unknown: no agreeing SOL price right now</>
            )}
          </div>
        </div>
        <div className="grid content-between gap-6 bg-ink p-7">
          <Metric k="Payouts sent" v={fmtInt(d.totals.count)} sub={d.totals.firstAt ? <>first {when(d.totals.firstAt)}</> : "none yet"} />
          <Metric k="Wallets paid" v={fmtInt(d.totals.wallets)} sub="distinct addresses that claimed" />
        </div>
        <div className="grid content-between gap-6 bg-ink p-7">
          <Metric k="Epochs settled" v={fmtInt(d.liveEpochs)} sub={latest ? <>latest {latest.id.replace(/^E-/, "")}</> : "none yet"} />
          <Metric k="Allocated, not yet claimed" v={`${sol(unclaimed, 3)} SOL`} sub="settled to wallets that have not claimed" tone={unclaimed > 0 ? "warn" : undefined} />
        </div>
      </div>

      {/* Charts */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="SOL paid per day" right="last 30 days · UTC">
          <DailyPaid daily={d.daily} />
        </Panel>
        <Panel title="Hourly epochs" right={`last ${Math.min(72, d.epochs.length)} settled`}>
          <EpochBars epochs={d.epochs} />
        </Panel>
      </div>

      {/* Where the pool comes from */}
      {(() => {
        const p = d.poolSources;
        const total = p.fixedLamports + p.salesLamports;
        const salesShare = total > 0 ? p.salesLamports / total : 0;
        return (
          <Panel className="mt-6" title="Where the pool comes from" right={`${fmtInt(p.epochs)} live epochs`}>
            <div className="grid gap-6 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
              <Metric k="From the treasury" v={`${sol(p.fixedLamports, 2)} SOL`} sub="fixed amount the operator funds each hour" />
              <Metric k="From plan sales" v={`${sol(p.salesLamports, 3)} SOL`} tone={p.salesLamports > 0 ? "ok" : "muted"} sub={p.purchases > 0 ? <>{fmtInt(p.purchases)} purchases · ${p.salesUsd.toFixed(2)} received · {fmtInt(p.epochsWithSales)} epochs</> : "no purchase has added to the pool yet"} />
              <Metric k="Sales share of all pools" v={`${(100 * salesShare).toFixed(salesShare > 0 && salesShare < 0.01 ? 2 : 1)}%`} tone={salesShare > 0 ? undefined : "muted"} sub="the number that has to pass 50%" />
              <Metric k="First hour sales > treasury" v={p.firstSalesMajority ? p.firstSalesMajority.replace(/^E-/, "") : "not yet"} tone={p.firstSalesMajority ? "ok" : "muted"} sub={p.latest ? <>latest epoch: {sol(p.latest.fixedLamports, 2)} fixed + {sol(p.latest.salesLamports, 3)} sales</> : undefined} />
            </div>
            <div className="mt-4 h-[6px] w-full overflow-hidden rounded-full bg-chalk/[0.08]">
              <div className="h-full bg-ok" style={{ width: `${Math.max(salesShare > 0 ? 0.5 : 0, 100 * salesShare)}%` }} />
            </div>
            <div className="mt-3 font-mono text-[10.5px] text-chalk/40">
              Every hourly pool is the fixed treasury amount plus the contributors&apos; share of plan purchases confirmed on chain during that hour (SOL at face value, USDC at the recorded SOL/USD quote). Nothing else feeds it: no emissions, no staking, no token sales. The network pays for itself on the hour this bar passes half.
            </div>
          </Panel>
        );
      })()}

      {/* Latest payouts */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Latest payouts" right={`${Math.min(100, d.claims.length)} of ${fmtInt(d.totals.count)}`}>
          {d.claims.length === 0 ? (
            <div className="font-mono text-[12px] text-chalk/40">No payout has been sent yet. The first one appears here with its transaction.</div>
          ) : (
            <div className="font-mono text-[12px]">
              <div className="grid grid-cols-[150px_1fr_120px_110px] gap-3 border-b border-chalk/10 pb-2 text-[10px] uppercase tracking-[0.14em] text-chalk/40 max-md:grid-cols-[1fr_110px]">
                <span className="max-md:hidden">When</span>
                <span>Wallet</span>
                <span className="text-right">SOL</span>
                <span className="text-right max-md:hidden">Transaction</span>
              </div>
              {d.claims.map((c) => (
                <div key={c.id} className="grid grid-cols-[150px_1fr_120px_110px] items-center gap-3 border-b border-chalk/[0.06] py-2.5 text-chalk/75 max-md:grid-cols-[1fr_110px]">
                  <span className="text-chalk/45 max-md:hidden">{when(c.createdAt)}</span>
                  <span className="truncate">
                    <a href={accountUrl(c.wallet)} target="_blank" rel="noreferrer" className="text-chalk underline decoration-chalk/20 underline-offset-4 hover:decoration-chalk" title={c.wallet}>
                      {shortAddr(c.wallet)}
                    </a>
                  </span>
                  <span className="num text-right text-[14px] text-ok">{sol(c.lamports, 4)}</span>
                  <span className="text-right max-md:hidden">
                    {c.txSignature ? (
                      <a href={txUrl(c.txSignature)} target="_blank" rel="noreferrer" className="text-chalk/70 underline decoration-chalk/20 underline-offset-4 hover:text-chalk" title={c.txSignature}>
                        {c.txSignature.slice(0, 6)}…{c.txSignature.slice(-4)} ↗
                      </a>
                    ) : (
                      <span className={cx("text-[10px] uppercase tracking-[0.1em]", c.status === "confirmed" ? "text-ok" : "text-chalk/40")}>{c.status}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Recent epochs" right="hourly · live only">
          {d.epochs.length === 0 ? (
            <div className="font-mono text-[12px] text-chalk/40">{NO_DATA}</div>
          ) : (
            <div className="font-mono text-[12px]">
              <div className="grid grid-cols-[1fr_90px_90px_60px] gap-3 border-b border-chalk/10 pb-2 text-[10px] uppercase tracking-[0.14em] text-chalk/40">
                <span>Epoch (UTC)</span>
                <span className="text-right">Pool</span>
                <span className="text-right">Paid out</span>
                <span className="text-right">Wallets</span>
              </div>
              {d.epochs.slice(0, 24).map((e) => (
                <div key={e.id} className="grid grid-cols-[1fr_90px_90px_60px] items-center gap-3 border-b border-chalk/[0.06] py-2.5 text-chalk/75">
                  <span className="text-chalk/70">{e.id.replace(/^E-/, "").replace("T", " ").replace(":00Z", "")}</span>
                  <span className="num text-right text-[13px] text-chalk/60" title={e.pool && e.pool.salesLamports > 0 ? `${sol(e.pool.fixedLamports, 3)} fixed + ${sol(e.pool.salesLamports, 3)} from ${e.pool.purchases} plan purchase${e.pool.purchases === 1 ? "" : "s"} ($${e.pool.salesUsd} × ${e.pool.share})` : undefined}>
                    {sol(e.poolLamports, 3)}
                    {e.pool && e.pool.salesLamports > 0 && <span className="text-ok"> +</span>}
                  </span>
                  <span className="num text-right text-[13px] text-chalk">{sol(e.distributedLamports, 3)}</span>
                  <span className="text-right text-chalk/60">{e.participants}</span>
                </div>
              ))}
              {d.epochs.length > 24 && <div className="pt-3 text-[10.5px] text-chalk/40">{d.epochs.length - 24} more settled epochs are in the chart above.</div>}
            </div>
          )}
        </Panel>
      </div>

      <p className="mt-8 max-w-[760px] font-mono text-[11px] leading-relaxed text-chalk/40">
        &ldquo;Paid out&rdquo; counts claims the server sent on chain (status sent or confirmed); the signature on each row is the proof. &ldquo;Allocated&rdquo; is what settled epochs assigned to wallets; the difference is SOL contributors can still claim on{" "}
        <Link href="/rewards" className="text-chalk/60 underline decoration-chalk/20 underline-offset-4 hover:text-chalk">
          /rewards
        </Link>
        . Each epoch&apos;s pool is the fixed amount set by the operator (shown on{" "}
        <Link href="/economics" className="text-chalk/60 underline decoration-chalk/20 underline-offset-4 hover:text-chalk">
          /economics
        </Link>
        ) plus the contributors&apos; share of plan purchases confirmed on chain while the epoch was open; a green + marks an epoch where sales added to the pool, and hovering the figure shows the split. The USD line is today&apos;s market price applied to SOL already paid, not what it was worth when sent. Simulated epochs are excluded. Rendered {when(d.at)}.
      </p>
    </Shell>
  );
}
