"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtInt } from "@/lib/format";
import { loadIdentity } from "@/network/client/identity";
import { Metric, NO_DATA, Panel, SourceBadge, pct, sol, usd } from "./parts";

interface Econ {
  nodeId: string;
  verifiedCompute: number;
  customerJobs: number;
  subsidizedJobs: number;
  customerFundedUsd: number | null;
  creatorRewardLamports: number | null;
  tokenShare: number | null;
  rewardWeight: number | null;
  epochId: string;
}

/** Contributor economics for the node identity stored in this browser. */
export function YourNode() {
  const [id, setId] = useState<string | null>(null);
  const [econ, setEcon] = useState<Econ | null | "missing">(null);
  useEffect(() => {
    const ident = loadIdentity();
    setId(ident.id);
    fetch(`/api/nodes/${ident.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setEcon(j?.economics ?? "missing"))
      .catch(() => setEcon("missing"));
  }, []);

  const e = econ && econ !== "missing" ? econ : null;
  const totalKnown = e && (e.customerFundedUsd != null || e.creatorRewardLamports != null);
  return (
    <Panel title="Your node" right={<SourceBadge source="REAL" />}>
      {econ === "missing" || !id ? (
        <div className="font-mono text-[12px] text-chalk/50">
          This browser&apos;s node identity{id ? ` (${id})` : ""} has not joined this server yet.{" "}
          <Link href="/node" className="text-chalk underline underline-offset-4">
            Open the node screen →
          </Link>
        </div>
      ) : !e ? (
        <div className="font-mono text-[12px] text-chalk/40">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-3 lg:grid-cols-5">
            <Metric k="Node" v={<Link href={`/node/${e.nodeId}`} className="hover:underline">{e.nodeId}</Link>} />
            <Metric k="Verified compute" v={fmtInt(e.verifiedCompute)} />
            <Metric k="Customer jobs" v={e.customerJobs} sub="units inside a priced job" />
            <Metric k="Subsidized jobs" v={e.subsidizedJobs} sub="units with no customer price" />
            <Metric k="Reward weight" v={e.rewardWeight == null ? NO_DATA : pct(e.rewardWeight, 2)} sub={`open epoch ${e.epochId}`} />
            <Metric k="Customer-funded earnings" v={e.customerFundedUsd == null ? NO_DATA : usd(e.customerFundedUsd)} sub="accrued, not paid out" />
            <Metric k="Creator-reward earnings" v={e.creatorRewardLamports == null ? NO_DATA : sol(e.creatorRewardLamports)} sub="finalized epochs" />
            <Metric k="Total earnings" v={!totalKnown ? NO_DATA : <span className="text-[16px]">{[e.customerFundedUsd != null ? usd(e.customerFundedUsd) : null, e.creatorRewardLamports != null ? sol(e.creatorRewardLamports) : null].filter(Boolean).join(" + ")}</span>} />
            <Metric k="Token holdings" v={e.tokenShare == null ? <span className="text-chalk/40">no wallet linked</span> : pct(e.tokenShare, 4)} sub="of circulating supply" />
          </div>
          <p className="mt-5 text-[12px] leading-relaxed text-chalk/50">
            Holding the token is not a yield. It multiplies the reward on compute you actually did (at most {1.35}×, with diminishing returns); with zero verified compute the multiplier applies to zero.
          </p>
        </>
      )}
    </Panel>
  );
}
