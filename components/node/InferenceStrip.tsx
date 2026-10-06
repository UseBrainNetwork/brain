"use client";

import { inferenceWorker, useInference } from "@/network/client/inferenceWorker";
import { cx } from "@/lib/format";

/**
 * The node's inference stage: which layers it holds, download progress, hops served. Every figure
 * is this browser's own count; the server decides what was verified.
 */
export function InferenceStrip({ connected }: { connected: boolean }) {
  const s = useInference();
  if (!connected && s.phase === "off") return null;
  const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
  const label =
    !s.enabled
      ? "OFF"
      : s.phase === "assigning"
        ? "ASSIGNING STAGE"
        : s.phase === "downloading"
          ? `DOWNLOADING ${Math.round(s.progress * 100)}%`
          : s.phase === "ready"
            ? s.networkActive
              ? "SERVING"
              : "READY"
            : s.phase === "error"
              ? "ERROR"
              : "OFF";
  const tone = s.phase === "ready" ? (s.networkActive ? "text-ok" : "text-chalk") : s.phase === "error" ? "text-signal" : "text-chalk/60";
  return (
    <div className="border-t border-chalk/[0.08] px-6 py-4 text-[11px] uppercase tracking-[0.1em] md:px-10">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-chalk/40">Model stage</span>
          <span className={cx("font-semibold", tone)}>{label}</span>
          {s.stage != null && s.layers && (
            <span className="text-chalk/55">
              · {s.modelLabel} · stage {s.stage + 1}/{s.stages} · layers {s.layers[0]}–{s.layers[1] - 1} · {mb(s.downloadBytes)}
            </span>
          )}
          {s.phase === "ready" && (
            <span className="text-chalk/55">
              · {s.hops} hops · {s.tokens} tokens · {s.sessions} session{s.sessions === 1 ? "" : "s"} cached
            </span>
          )}
          {s.phase === "error" && s.error && <span className="normal-case tracking-normal text-signal/80">· {s.error}</span>}
        </div>
        <button type="button" onClick={() => inferenceWorker.setEnabled(!s.enabled)} className="text-chalk/40 hover:text-chalk">
          {s.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>
      {s.phase === "downloading" && (
        <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-chalk/10">
          <span className="block h-full bg-signal transition-[width] duration-300" style={{ width: `${Math.max(2, s.progress * 100)}%` }} />
        </div>
      )}
      <p className="mt-2 max-w-[760px] normal-case tracking-normal text-chalk/35">
        This node runs {s.layers ? `${s.layers[1] - s.layers[0]} of ${s.modelLabel ? "the model's" : ""} transformer layers` : "a slice of a small language model"} for NETWORK-mode chat. Each hop is run by two nodes and
        compared by the server; only matching work is credited.
      </p>
    </div>
  );
}
