"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button, Dot, Prov } from "@/components/ui";
import { cx, fmtInt, fmtMs } from "@/lib/format";

const DEFAULT_PROMPT = `Explain why this Solidity contract is vulnerable and how to fix it.

contract Vault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
        balances[msg.sender] = 0;
    }
}`;

const MODELS = ["brain/auto", "brain/qwen", "brain/code"] as const;
const IDLE_NODES = ["8A21", "19F2", "81CC", "28AA"];

interface Shard {
  nodeId: string;
  layers: string;
  units: number;
}
interface Candidate {
  target: string;
  providerId: string;
  eligible: boolean;
  score: number;
  notes: string[];
}
interface BrainExt {
  target?: string;
  provider?: string;
  latencyMs?: number;
  routing?: { ranked: Candidate[]; selected: Candidate | null };
  plan?: { provenance: "simulated"; shards: Shard[] };
}
interface Result {
  ok: boolean;
  status: number;
  content?: string;
  error?: { code: string; message: string } | string;
  brain?: BrainExt;
  usage?: { total_tokens: number };
  clientMs: number;
}

type Phase = "idle" | "routing" | "split" | "nodes" | "merge" | "done";
const ORDER: Phase[] = ["idle", "routing", "split", "nodes", "merge", "done"];
const reached = (p: Phase, q: Phase) => ORDER.indexOf(p) >= ORDER.indexOf(q);

export function Playground() {
  const [model, setModel] = useState<(typeof MODELS)[number]>("brain/auto");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [phase, setPhase] = useState<Phase>("idle");
  const [res, setRes] = useState<Result | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function run() {
    timers.current.forEach(clearTimeout);
    setRes(null);
    setPhase("routing");
    const t0 = performance.now();
    let out: Result;
    try {
      const r = await fetch("/api/playground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 700 }),
      });
      const d = await r.json().catch(() => ({}));
      out = {
        ok: r.ok,
        status: r.status,
        content: d?.choices?.[0]?.message?.content,
        error: d?.error,
        brain: d?.brain,
        usage: d?.usage,
        clientMs: performance.now() - t0,
      };
    } catch {
      out = { ok: false, status: 0, error: { code: "network_error", message: "Could not reach the gateway." }, clientMs: performance.now() - t0 };
    }
    // Replay the (simulated) shard plan the router produced for this request, then show the real result.
    const seq: [Phase, number][] = out.brain?.plan ? [["split", 0], ["nodes", 380], ["merge", 1300], ["done", 1750]] : [["done", 0]];
    for (const [p, at] of seq) timers.current.push(setTimeout(() => setPhase(p), at));
    timers.current.push(setTimeout(() => setRes(out), seq[seq.length - 1][1]));
  }

  const shards = res?.brain?.plan?.shards;
  const units = shards?.reduce((s, x) => s + x.units, 0);
  const busy = phase !== "idle" && phase !== "done";
  const err = typeof res?.error === "string" ? { code: res.error, message: res.error } : res?.error;

  return (
    <div className="grid gap-px overflow-hidden rounded-[24px] bg-chalk/10 lg:grid-cols-[1.05fr_1fr]">
      {/* input */}
      <div className="flex flex-col bg-ink-2 p-5 md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="label text-chalk/50">Request</span>
          <div className="flex rounded-full bg-chalk/[0.06] p-1">
            {MODELS.map((m) => (
              <button
                key={m}
                onClick={() => setModel(m)}
                className={cx("h-8 rounded-full px-3.5 font-mono text-[11.5px] transition-colors", model === m ? "bg-chalk text-ink" : "text-chalk/60 hover:text-chalk")}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          aria-label="Prompt"
          className="mt-5 min-h-[340px] flex-1 resize-none rounded-[14px] bg-[#0f0f0e] p-5 font-mono text-[12.5px] leading-[1.7] text-chalk/85 outline-none ring-1 ring-chalk/[0.07] focus:ring-chalk/25"
        />
        <div className="mt-5 flex items-center justify-between gap-4">
          <span className="font-mono text-[11px] text-chalk/35">POST /v1/chat/completions · {prompt.length.toLocaleString()} chars</span>
          <Button variant="signal" onClick={run} disabled={busy || !prompt.trim()} arrow>
            {busy ? "Running…" : "Run on Brain"}
          </Button>
        </div>
      </div>

      {/* route + result */}
      <div className="flex flex-col bg-ink p-5 md:p-7">
        <div className="flex items-center justify-between">
          <span className="label text-chalk/50">Execution</span>
          {shards && (
            <span className="flex items-center gap-2 font-mono text-[10.5px] text-chalk/40">
              shard plan <Prov p="simulated" />
            </span>
          )}
        </div>

        <FlowViz phase={phase} shards={shards} />

        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] bg-chalk/10 md:grid-cols-4">
          <Stat k="Nodes used" v={shards ? String(shards.length) : "—"} p="simulated" />
          <Stat k="Latency" v={res ? fmtMs(res.brain?.latencyMs ?? res.clientMs) : "—"} p="live" />
          <Stat k="Compute units" v={units ? `${units}u` : "—"} p="simulated" />
          <Stat k="Tokens" v={res?.usage?.total_tokens ? fmtInt(res.usage.total_tokens) : "—"} p="live" />
        </div>

        <div className="mt-6 min-h-[220px] flex-1">
          <AnimatePresence mode="wait">
            {!res && (
              <motion.div key="wait" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="font-mono text-[12px] text-chalk/35">
                {phase === "idle" ? "Run the prompt to see how the router places it." : phase === "routing" ? "Evaluating execution targets…" : "Executing…"}
              </motion.div>
            )}
            {res?.ok && (
              <motion.div key="ok" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[11px] text-chalk/50">
                  <Dot color="ok" /> executed on <span className="text-chalk">{res.brain?.target}</span> via {res.brain?.provider}
                  {res.usage && <span>· {res.usage.total_tokens} tokens</span>}
                </div>
                <div className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-[14px] bg-ink-2 p-5 text-[14px] leading-relaxed text-chalk/85">{res.content}</div>
              </motion.div>
            )}
            {res && !res.ok && (
              <motion.div key="err" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-[14px] bg-ink-2 p-5">
                <div className="flex items-center gap-2 font-mono text-[11.5px] font-semibold text-warn">
                  <Dot color="warn" /> {res.status || "ERR"} · {err?.code ?? "error"}
                </div>
                <p className="mt-3 text-[14px] leading-relaxed text-chalk/75">
                  {err?.code === "no_provider_available"
                    ? "The router evaluated every execution target and none can serve this model yet. The browser pool doesn't run LLM layers in V1, and no cloud fallback or external provider is configured on this server, so nothing was faked."
                    : err?.message}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          {res?.brain?.routing && <RoutingTrace c={res.brain.routing.ranked} selected={res.brain.routing.selected?.providerId} />}
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, p }: { k: string; v: string; p: "live" | "simulated" | "estimated" }) {
  return (
    <div className="bg-ink-2 px-4 py-3.5">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-chalk/40">
        {k} <Prov p={p} />
      </div>
      <div className="num mt-1.5 text-[20px]">{v}</div>
    </div>
  );
}

function Box({ on, hot, children, className }: { on: boolean; hot?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "grid h-10 place-items-center rounded-[10px] font-mono text-[11.5px] font-semibold tracking-[0.04em] transition-all duration-300",
        on ? (hot ? "bg-signal text-white" : "bg-chalk text-ink") : "bg-chalk/[0.05] text-chalk/40 ring-1 ring-chalk/10",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Wire({ on }: { on: boolean }) {
  return (
    <div className="relative mx-auto h-5 w-px overflow-hidden bg-chalk/15">
      {on && <motion.span className="absolute left-0 top-0 h-2 w-px bg-signal" initial={{ y: -8 }} animate={{ y: 20 }} transition={{ duration: 0.5, repeat: Infinity, ease: "linear" }} />}
    </div>
  );
}

function FlowViz({ phase, shards }: { phase: Phase; shards?: Shard[] }) {
  const nodes = shards ?? IDLE_NODES.map((nodeId) => ({ nodeId, layers: "", units: 0 }));
  const live = phase !== "idle";
  return (
    <div className="mt-5 rounded-[16px] bg-[#0f0f0e] p-5 ring-1 ring-chalk/[0.06]">
      <Box on={live} hot={phase === "routing"} className="mx-auto w-40">
        REQUEST
      </Box>
      <Wire on={phase === "routing" || phase === "split"} />
      <Box on={reached(phase, "split")} hot={phase === "split"} className="mx-auto w-40">
        SPLIT
      </Box>
      <Wire on={phase === "split" || phase === "nodes"} />
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(nodes.length, 4)}, minmax(0,1fr))` }}>
        {nodes.map((n, i) => (
          <motion.div
            key={n.nodeId + i}
            initial={false}
            animate={{ opacity: 1 }}
            className={cx(
              "relative overflow-hidden rounded-[10px] px-2 py-2 text-center font-mono transition-colors duration-300",
              reached(phase, "nodes") ? "bg-chalk/[0.08] text-chalk ring-1 ring-chalk/25" : "bg-chalk/[0.03] text-chalk/35 ring-1 ring-chalk/10",
            )}
          >
            <div className="text-[10.5px] font-semibold">NODE {n.nodeId}</div>
            <div className="mt-0.5 text-[9.5px] text-chalk/40">{n.layers ? `L${n.layers} · ${n.units}u` : "idle"}</div>
            {phase === "nodes" && (
              <motion.span className="absolute bottom-0 left-0 h-[2px] bg-signal" initial={{ width: 0 }} animate={{ width: "100%" }} transition={{ duration: 0.5 + ((i * 37) % 40) / 100, ease: "easeOut" }} />
            )}
            {reached(phase, "merge") && <span className="absolute bottom-0 left-0 h-[2px] w-full bg-ok" />}
          </motion.div>
        ))}
      </div>
      <Wire on={phase === "nodes" || phase === "merge"} />
      <Box on={reached(phase, "merge")} hot={phase === "merge"} className="mx-auto w-40">
        MERGE
      </Box>
      <Wire on={phase === "merge"} />
      <Box on={phase === "done"} className="mx-auto w-40">
        RESPONSE
      </Box>
    </div>
  );
}

function RoutingTrace({ c, selected }: { c: Candidate[]; selected?: string }) {
  return (
    <div className="mt-5">
      <div className="label mb-2 text-chalk/45">Routing decision</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] font-mono text-[11.5px]">
          <tbody>
            {c.map((x) => (
              <tr key={x.providerId} className="border-b border-chalk/[0.07] align-top">
                <td className="py-2 pr-3">
                  <span className={cx(x.providerId === selected ? "text-ok" : x.eligible ? "text-chalk" : "text-chalk/40")}>{x.target}</span>
                </td>
                <td className="py-2 pr-3 text-right">{x.eligible ? x.score.toFixed(3) : "—"}</td>
                <td className="py-2 text-chalk/50">{x.providerId === selected ? "selected" : x.eligible ? "standby" : x.notes.join("; ") || "ineligible"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
