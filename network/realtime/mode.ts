"use client";

import { useSyncExternalStore } from "react";

/**
 * Site data mode.
 *  demo → simulated network activity is blended in (and labeled SIM) so the product reads as busy.
 *  real → nothing simulated anywhere: counts, feeds and metrics come only from this server.
 * /demo and /node are always real regardless of this setting.
 */
export type DataMode = "demo" | "real";

const KEY = "brain.mode.v1";
const listeners = new Set<() => void>();
let mode: DataMode | null = null;

function read(): DataMode {
  if (mode) return mode;
  if (typeof window === "undefined") return "demo";
  const q = new URLSearchParams(window.location.search).get("mode");
  if (q === "real" || q === "demo") {
    localStorage.setItem(KEY, q);
    return (mode = q);
  }
  const v = localStorage.getItem(KEY);
  return (mode = v === "real" ? "real" : "demo");
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
  return useSyncExternalStore(onModeChange, read, () => "demo");
}
