"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

interface Target {
  id: string;
  label: string;
  sub: string;
  state: string;
  ok: boolean;
}

/**
 * Client → Gateway → Router → targets → Response. One packet at a time walks the path; the
 * router sends it to the first target that is actually available on this server.
 */
export function Architecture({ fallback, external }: { fallback: boolean; external: boolean }) {
  const targets: Target[] = [
    { id: "BROWSER_NETWORK", label: "Browser pool", sub: "WebGPU nodes", state: "V1: verify jobs only", ok: false },
    { id: "CLOUD_FALLBACK", label: "Cloud fallback", sub: "OpenAI-compatible", state: fallback ? "configured" : "not configured", ok: fallback },
    { id: "EXTERNAL_MODEL_PROVIDER", label: "External provider", sub: "OpenAI-compatible", state: external ? "configured" : "not configured", ok: external },
  ];
  const chosen = targets.findIndex((t) => t.ok);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % 6), 900);
    return () => clearInterval(t);
  }, []);

  const lit = (i: number) => step >= i;
  return (
    <div className="rounded-[22px] bg-ink-2 p-5 ring-1 ring-chalk/[0.06] md:p-8">
      <div className="grid items-center gap-3 lg:grid-cols-[0.9fr_24px_1fr_24px_0.9fr_24px_1.7fr_24px_0.9fr]">
        <Node on={lit(0)} title="Client" sub="OpenAI SDK / curl" />
        <Link on={lit(1)} />
        <Node on={lit(1)} title="Gateway" sub="auth · validate · rate limit" />
        <Link on={lit(2)} />
        <Node on={lit(2)} hot={step === 2} title="Router" sub="rank eligible targets" />
        <Link on={lit(3)} />
        <div className="grid gap-2">
          {targets.map((t, i) => (
            <div
              key={t.id}
              className={cx(
                "rounded-[12px] px-4 py-3 ring-1 transition-colors duration-300",
                lit(3) && i === chosen ? "bg-chalk text-ink ring-chalk" : "bg-chalk/[0.03] text-chalk ring-chalk/10",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-semibold">{t.label}</span>
                <span className={cx("font-mono text-[10px]", lit(3) && i === chosen ? "text-ink/60" : t.ok ? "text-ok" : "text-chalk/35")}>{t.state}</span>
              </div>
              <div className={cx("mt-0.5 font-mono text-[10.5px]", lit(3) && i === chosen ? "text-ink/55" : "text-chalk/40")}>{t.id}</div>
            </div>
          ))}
        </div>
        <Link on={lit(4) && chosen >= 0} />
        <Node on={lit(4)} hot={step >= 4} title="Response" sub={chosen >= 0 ? "200 · brain.target set" : "503 · routing trace"} warn={chosen < 0} />
      </div>
      <p className="mt-6 font-mono text-[11px] text-chalk/40">
        {chosen >= 0
          ? `This server would route to ${targets[chosen].id} right now.`
          : "No target can serve LLM requests on this server right now; the gateway returns 503 with the routing trace instead of a fabricated answer."}
      </p>
    </div>
  );
}

function Node({ on, hot, warn, title, sub }: { on: boolean; hot?: boolean; warn?: boolean; title: string; sub: string }) {
  return (
    <div className={cx("rounded-[12px] px-4 py-4 ring-1 transition-colors duration-300", on ? (hot ? (warn ? "bg-warn text-ink ring-warn" : "bg-signal text-white ring-signal") : "bg-chalk/[0.08] ring-chalk/30") : "bg-chalk/[0.02] ring-chalk/10")}>
      <div className="text-[15px] font-semibold">{title}</div>
      <div className={cx("mt-1 font-mono text-[10.5px]", hot ? "opacity-75" : "text-chalk/45")}>{sub}</div>
    </div>
  );
}

function Link({ on }: { on: boolean }) {
  return (
    <div className="relative mx-auto h-5 w-px overflow-hidden bg-chalk/15 lg:h-px lg:w-full">
      <motion.span
        className="absolute inset-0 origin-top bg-signal lg:origin-left"
        initial={false}
        animate={{ opacity: on ? 1 : 0 }}
        transition={{ duration: 0.25 }}
      />
    </div>
  );
}
