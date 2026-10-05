"use client";

import { useSyncExternalStore } from "react";

/**
 * Site data mode. Default is REAL: nothing simulated anywhere; counts, feeds and metrics come only
 * from this server. "Show simulated data" (footer) switches to DEMO, where a simulated network is
 * blended in and every such number is labeled SIM. /demo and /node are always real.
 */
export type DataMode = "demo" | "real";

const KEY = "brain.mode.v1";
const listeners = new Set<() => void>();
let mode: DataMode | null = null;

function read(): DataMode {
  if (mode) return mode;
  if (typeof window === "undefined") return "real";
  const q = new URLSearchParams(window.location.search).get("mode");
  if (q === "real" || q === "demo") {
    localStorage.setItem(KEY, q);
    return (mode = q);
  }
  const v = localStorage.getItem(KEY);
  return (mode = v === "demo" ? "demo" : "real");
}

export function getMode(): DataMode {
  return read();
}

export function setMode(m: DataMode) {
  mode = m;
  localStorage.setItem(KEY, m);
  listeners.forEach((l) => l());
}

export function onModeChange(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useMode(): DataMode {
  return useSyncExternalStore(onModeChange, read, () => "real");
}

/** True when simulated data may be shown. */
export function useSim(): boolean {
  return useMode() === "demo";
}
