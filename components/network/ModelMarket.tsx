"use client";

import { useMemo } from "react";
import { MODEL_ALLOWLIST } from "@/node/models";
import { cx } from "@/lib/format";
import { Panel } from "@/components/economy/parts";
import { Tag, gb, median, useFleet } from "@/components/network/NativeFleet";

/** The allowlist joined with the live registry. Nothing here is estimated: counts are nodes, speeds are coordinator-timed. */
export function ModelMarket() {
  const { nodes } = useFleet(8_000);
  const rows = useMemo(() => {
    const live = (nodes ?? []).filter((n) => n.state === "ONLINE" || n.state === "BUSY");
    return MODEL_ALLOWLIST.map((m) => {
      const serving = live.filter((n) => n.supportedModels.includes(m.id));
      const loaded = serving.filter((n) => n.loadedModels.includes(m.id));
      const speeds = serving.flatMap((n) => n.measured.tokPerSec);
      const asks = serving.map((n) => n.askUsdPer1MTokens).filter((x): x is number => x != null);
      return { m, serving, loaded, tokPerSec: speeds.length ? median(speeds) : null, ask: asks.length ? Math.min(...asks) : null, regions: [...new Set(serving.map((n) => n.region).filter(Boolean))] as string[] };
    });
  }, [nodes]);

  return (
    <Panel title="Allowlisted models" right={nodes ? <span>{nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY").length} nodes online</span> : <span>loading</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-[12px]">
          <thead className="text-[10px] uppercase tracking-[0.12em] text-chalk/40">
            <tr>
              {["Model", "Params", "Context", "Min VRAM", "License", "Nodes online", "Loaded", "Speed", "Lowest ask", "Regions", "Status"].map((h) => (
                <th key={h} className="pb-2 pr-4 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-chalk/80">
            {rows.map(({ m, serving, loaded, tokPerSec, ask, regions }) => {
              const status = m.mock ? "mock" : serving.length ? "available" : "no nodes";
              return (
                <tr key={m.id} className="border-t border-chalk/5">
                  <td className="py-2.5 pr-4 text-chalk">
                    {m.id} {m.mock && <Tag tone="warn">mock</Tag>}
                  </td>
                  <td className="py-2.5 pr-4">{m.params}</td>
                  <td className="py-2.5 pr-4">{(m.context / 1024).toFixed(0)}k</td>
                  <td className="py-2.5 pr-4">{m.minVramMb ? gb(m.minVramMb) : "—"}</td>
                  <td className="py-2.5 pr-4">{m.license}</td>
                  <td className="py-2.5 pr-4">{nodes ? serving.length : "…"}</td>
                  <td className="py-2.5 pr-4">{nodes ? loaded.length : "…"}</td>
                  <td className="py-2.5 pr-4">{tokPerSec == null ? "unmeasured" : `${tokPerSec.toFixed(0)} tok/s`}</td>
                  <td className="py-2.5 pr-4">{ask == null ? (serving.length ? "list price" : "—") : `$${ask.toFixed(2)} / 1M`}</td>
                  <td className="py-2.5 pr-4">{regions.join(", ") || "—"}</td>
                  <td className={cx("py-2.5 pr-4 uppercase", status === "available" ? "text-ok" : status === "mock" ? "text-warn" : "text-chalk/40")}>{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-5 max-w-[720px] font-mono text-[11px] leading-relaxed text-chalk/40">
        Speed is the median of coordinator-timed tokens per second on completed jobs for nodes currently serving the model; it reads unmeasured until a job has run. Pricing: the network list price applies unless a node sets an ask; asks are a routing input and are shown on the node&apos;s provider page.
      </p>
    </Panel>
  );
}
