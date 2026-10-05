"use client";

import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

/** "Tell me when it opens" for a coming-soon plan. Stores interest on the account; nothing is charged. */
export function NotifyButton({ plan, dark }: { plan: string; dark?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  useEffect(() => {
    fetch("/api/account/interest", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => Array.isArray(j.plans) && j.plans.includes(plan) && setState("done"))
      .catch(() => {});
  }, [plan]);
  const go = async () => {
    setState("busy");
    try {
      const r = await fetch("/api/account/interest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) });
      setState(r.ok ? "done" : "idle");
    } catch {
      setState("idle");
    }
  };
  return (
    <button
      type="button"
      onClick={go}
      disabled={state !== "idle"}
      className={cx(
        "inline-flex h-11 w-full items-center justify-center rounded-full px-5 text-[14px] font-semibold transition-colors",
        state === "done" ? (dark ? "bg-ok/15 text-ok" : "bg-ok/15 text-ink") : dark ? "bg-chalk text-ink hover:bg-white" : "bg-ink text-chalk hover:bg-ink/85",
        state === "busy" && "opacity-60",
      )}
    >
      {state === "done" ? "You'll be told when it opens" : state === "busy" ? "Saving…" : "Tell me when it opens"}
    </button>
  );
}
