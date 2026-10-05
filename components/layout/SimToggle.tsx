"use client";

import { setMode, useSim } from "@/network/realtime/mode";
import { cx } from "@/lib/format";

/** Footer control. Off by default: the site shows only real data. On: a simulated network is blended in, every such figure labeled SIM. */
export function SimToggle({ className }: { className?: string }) {
  const sim = useSim();
  return (
    <button
      type="button"
      onClick={() => setMode(sim ? "real" : "demo")}
      className={cx("inline-flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] ring-1 ring-inset transition-colors", sim ? "bg-warn/15 text-warn ring-warn/40 hover:bg-warn/25" : "text-chalk/50 ring-chalk/15 hover:text-chalk", className)}
      title={sim ? "Simulated network data is blended in and labeled SIM. Click to show real data only." : "Show a simulated network alongside real data, labeled SIM, to preview how the product reads at scale."}
    >
      <span className={cx("size-[6px] rounded-full", sim ? "bg-warn" : "bg-chalk/30")} />
      {sim ? "Hide simulated data" : "Show simulated data"}
    </button>
  );
}
