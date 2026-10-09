"use client";

import { useEffect, useMemo, useState } from "react";
import { MODEL_ALLOWLIST } from "@/node/models";
import { cx } from "@/lib/format";
import { Panel } from "@/components/economy/parts";
import { Tag, gb, median, useFleet } from "@/components/network/NativeFleet";

interface Demand {
  model: string;
  asked: number;
  served: number;
  unserved: number;
  p50Ms: number | null;
}

function useDemand(intervalMs = 60_000) {
  const [d, setD] = useState<{ models: Demand[]; asOf: number; stale: boolean } | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/models/demand")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => alive && setD(j))
        .catch(() => alive && setD(null));
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return d;
}

/**
 * The allowlist joined with the live registry and the last 24 h of orders. Nothing here is
 * estimated: counts are nodes and orders, speeds are coordinator-timed. Sorted so the models
 * customers asked for and nobody served come first — that is where an operator should pin.
 */
export function ModelMarket() {
  const { nodes } = useFleet(8_000);
  const demand = useDemand();
  const rows = useMemo(() => {
    const live = (nodes ?? []).filter((n) => n.state === "ONLINE" || n.state === "BUSY");
    const dm = new Map((demand?.models ?? []).map((x) => [x.model, x]));
    return MODEL_ALLOWLIST.map((m) => {
      const serving = live.filter((n) => n.supportedModels.includes(m.id));
      const loaded = serving.filter((n) => n.loadedModels.includes(m.id));
      const speeds = serving.flatMap((n) => n.measured.tokPerSec);
      const asks = serving.map((n) => n.askUsdPer1MTokens).filter((x): x is number => x != null);
      const d = dm.get(m.id) ?? null;
      return { m, serving, loaded, tokPerSec: speeds.length ? median(speeds) : null, ask: asks.length ? Math.min(...asks) : null, regions: [...new Set(serving.map((n) => n.region).filter(Boolean))] as string[], d };
    }).sort((a, b) => {
      if (a.m.mock !== b.m.mock) return a.m.mock ? 1 : -1;
      const ua = a.d?.unserved ?? 0;
      const ub = b.d?.unserved ?? 0;
      if (ua !== ub) return ub - ua;
      if (a.serving.length !== b.serving.length) return b.serving.length - a.serving.length;
      return (b.d?.asked ?? 0) - (a.d?.asked ?? 0);
    });
  }, [nodes, demand]);

  const wanted = rows.filter((r) => (r.d?.unserved ?? 0) > 0 && r.serving.length === 0);

  return (
    <div className="space-y-5">
      <Panel title="Allowlisted models" right={nodes ? <span>{nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY").length} nodes online</span> : <span>loading</span>}>
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">
              <tr>
                {["Model", "Params", "Min VRAM", "License", "Nodes online", "Loaded", "Speed", "Lowest ask", "Regions", "Asked 24h", "Served", "Unserved", "Status"].map((h) => (
                  <th key={h} className="pb-2 pr-4 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-chalk/80">
              {rows.map(({ m, serving, loaded, tokPerSec, ask, regions, d }) => {
                const status = m.mock ? "mock" : serving.length ? "available" : (d?.unserved ?? 0) > 0 ? "wanted" : "no nodes";
                const dem = demand === undefined ? "…" : demand === null ? "—" : null;
                return (
                  <tr key={m.id} className="border-t border-chalk/5">
                    <td className="py-2.5 pr-4 text-chalk">
                      {m.id} {m.mock && <Tag tone="warn">mock</Tag>}
                    </td>
                    <td className="py-2.5 pr-4">{m.params}</td>
                    <td className="py-2.5 pr-4">{m.minVramMb ? gb(m.minVramMb) : "—"}</td>
                    <td className="py-2.5 pr-4 max-w-[180px] truncate" title={m.license}>
                      {m.license}
                    </td>
                    <td className="py-2.5 pr-4">{nodes ? serving.length : "…"}</td>
                    <td className="py-2.5 pr-4">{nodes ? loaded.length : "…"}</td>
                    <td className="py-2.5 pr-4">{tokPerSec == null ? "unmeasured" : `${tokPerSec.toFixed(0)} tok/s`}</td>
                    <td className="py-2.5 pr-4">{ask == null ? (serving.length ? "list price" : "—") : `$${ask.toFixed(2)} / 1M`}</td>
                    <td className="py-2.5 pr-4">{regions.join(", ") || "—"}</td>
                    <td className="py-2.5 pr-4">{dem ?? (d?.asked ?? 0)}</td>
                    <td className="py-2.5 pr-4">{dem ?? (d?.served ?? 0)}</td>
                    <td className={cx("py-2.5 pr-4", (d?.unserved ?? 0) > 0 && "text-warn")}>{dem ?? (d?.unserved ?? 0)}</td>
                    <td className={cx("py-2.5 pr-4 uppercase", status === "available" ? "text-ok" : status === "wanted" ? "text-warn" : status === "mock" ? "text-warn" : "text-chalk/40")}>{status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-5 max-w-[760px] font-mono text-[11px] leading-relaxed text-chalk/40">
          Speed is the median of coordinator-timed tokens per second on completed jobs for nodes currently serving the model; it reads unmeasured until a job has run. Asked / served / unserved are counts of customer orders naming the model in the last 24 h, from the order log; unserved means no node could take it or every attempt failed. Pricing: the network list price applies unless a node sets an ask; asks are a routing input and are shown on the node&apos;s provider page.
          {demand?.stale ? " Demand figures are the last successful read." : ""}
        </p>
      </Panel>

      <Panel title="Pin a model" right={wanted.length ? <span className="text-warn">{wanted.length} wanted, unserved</span> : <span>operators</span>}>
        <p className="max-w-[760px] text-[13.5px] leading-relaxed text-chalk/60">
          A request that names a model only ever goes to a node serving that model. Pin the ones you want to compete on and the router sends you that traffic, ranked against other nodes on capability, availability, measured latency, reputation and your ask price. Pinned models are advertised on registration and checked against what your server actually serves.
        </p>
        {wanted.length > 0 && (
          <p className="mt-3 max-w-[760px] text-[13.5px] leading-relaxed text-chalk/60">
            Asked for in the last 24 h with no node online to serve: <span className="font-mono text-chalk">{wanted.map((r) => r.m.id).join(", ")}</span>.
          </p>
        )}
        <pre className="mt-5 overflow-x-auto rounded-md bg-ink/60 p-4 font-mono text-[12px] leading-relaxed text-chalk/80">
          {`# vLLM (NVIDIA): the agent pulls and serves the pinned ids
BRAIN_NODE_MODE=vllm BRAIN_NODE_MODELS=qwen/qwen2.5-32b-instruct-awq,qwen/qwen2.5-coder-32b-instruct-awq npm run node

# Ollama / llama.cpp / mlx-lm / exo: serve the model yourself, pin what to advertise
ollama pull qwen2.5:32b-instruct
BRAIN_NODE_MODE=ollama BRAIN_NODE_MODELS=qwen/qwen2.5-32b-instruct npm run node

# Optional: an ask price per 1M tokens; the router treats it as one input among five
BRAIN_NODE_ASK_USD_PER_1M=0.40`}
        </pre>
      </Panel>
    </div>
  );
}
