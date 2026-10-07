"use client";

import { useEffect, useState } from "react";
import { MODE_KEY } from "@/lib/colorMode";
import { cx } from "@/lib/format";

export type ColorMode = "light" | "dark";
export type ColorPref = ColorMode | "system";

function readPref(): ColorPref {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(MODE_KEY);
  return v === "dark" || v === "light" ? v : "system";
}

function resolve(pref: ColorPref): ColorMode {
  if (pref !== "system") return pref;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(pref: ColorPref) {
  const mode = resolve(pref);
  document.documentElement.dataset.mode = mode;
  window.dispatchEvent(new CustomEvent("brain:mode", { detail: mode }));
}

export function setColorPref(pref: ColorPref) {
  if (pref === "system") window.localStorage.removeItem(MODE_KEY);
  else window.localStorage.setItem(MODE_KEY, pref);
  apply(pref);
}

/** Resolved mode (light/dark) and the stored preference. Starts as light on the server; corrects on mount. */
export function useColorMode(): { mode: ColorMode; pref: ColorPref } {
  const [state, setState] = useState<{ mode: ColorMode; pref: ColorPref }>({ mode: "light", pref: "system" });
  useEffect(() => {
    const sync = () => setState({ mode: (document.documentElement.dataset.mode as ColorMode) ?? resolve(readPref()), pref: readPref() });
    sync();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => {
      if (readPref() === "system") apply("system");
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_KEY) apply(readPref());
    };
    window.addEventListener("brain:mode", sync);
    window.addEventListener("storage", onStorage);
    mq.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener("brain:mode", sync);
      window.removeEventListener("storage", onStorage);
      mq.removeEventListener("change", onSystem);
    };
  }, []);
  return state;
}

/** Light / dark switch. Always rendered on a dark surface (nav menus, footer), so it uses chalk tokens. */
export function ModeToggle({ className, size = "sm" }: { className?: string; size?: "sm" | "md" }) {
  const { mode } = useColorMode();
  const next: ColorMode = mode === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setColorPref(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cx(
        "inline-flex items-center gap-2 rounded-full font-mono uppercase tracking-[0.12em] text-chalk/50 ring-1 ring-inset ring-chalk/15 transition-colors hover:text-chalk",
        size === "sm" ? "px-3 py-1.5 text-[10.5px]" : "px-4 py-2.5 text-[12px]",
        className,
      )}
    >
      <span aria-hidden className="relative inline-block size-[10px]">
        <span className={cx("absolute inset-0 rounded-full transition-colors", mode === "dark" ? "bg-chalk/70" : "bg-transparent ring-1 ring-chalk/60")} />
        {mode === "dark" && <span className="absolute left-[3px] top-[-1px] size-[8px] rounded-full bg-ink" />}
      </span>
      {mode === "dark" ? "Dark" : "Light"}
    </button>
  );
}
