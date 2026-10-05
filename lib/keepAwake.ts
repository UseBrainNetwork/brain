"use client";

import { useEffect, useState } from "react";

/**
 * Keeps a contributing tab working. Two real browser facts, surfaced honestly:
 *  - Screen Wake Lock (where supported, on a secure context) stops the display from sleeping while
 *    the node is active. It is re-acquired when the tab comes back to the foreground, because browsers
 *    release it on hide.
 *  - Background tabs are throttled: timers slow to ≥1/s and WebGPU work may stall. We cannot stop
 *    that; we can tell the operator.
 */
export interface KeepAwake {
  /** "held" = lock active; "unsupported" = API missing or denied; "off" = not requested. */
  wakeLock: "held" | "unsupported" | "off";
  /** True while the tab is hidden (another tab in front, window minimized). */
  hidden: boolean;
  /** Seconds the tab has been hidden, for the warning copy. 0 when visible. */
  hiddenFor: number;
}

type Sentinel = { release: () => Promise<void>; addEventListener: (t: "release", f: () => void) => void };

export function useKeepAwake(active: boolean): KeepAwake {
  const [wakeLock, setWakeLock] = useState<KeepAwake["wakeLock"]>("off");
  const [hidden, setHidden] = useState(false);
  const [hiddenFor, setHiddenFor] = useState(0);

  useEffect(() => {
    if (!active) {
      setWakeLock("off");
      return;
    }
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Sentinel> } };
    let sentinel: Sentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (!nav.wakeLock || document.visibilityState !== "visible") return;
      try {
        sentinel = await nav.wakeLock.request("screen");
        if (stopped) {
          await sentinel.release();
          return;
        }
        setWakeLock("held");
        sentinel.addEventListener("release", () => {
          sentinel = null;
          if (!stopped) setWakeLock((w) => (w === "held" ? "off" : w));
        });
      } catch {
        setWakeLock("unsupported");
      }
    };
    if (!nav.wakeLock) setWakeLock("unsupported");
    else void acquire();

    let hiddenAt = 0;
    let tick: ReturnType<typeof setInterval> | null = null;
    const onVis = () => {
      const h = document.visibilityState !== "visible";
      setHidden(h);
      if (h) {
        hiddenAt = Date.now();
        setHiddenFor(0);
        tick = setInterval(() => setHiddenFor(Math.round((Date.now() - hiddenAt) / 1000)), 1000);
      } else {
        if (tick) clearInterval(tick);
        tick = null;
        setHiddenFor(0);
        if (!sentinel) void acquire();
      }
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVis);
      if (tick) clearInterval(tick);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);

  return { wakeLock, hidden, hiddenFor };
}
