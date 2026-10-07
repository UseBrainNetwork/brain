"use client";

import { useEffect, useRef, useState } from "react";
import type { NetworkEvent } from "@/domain/types";
import { cx } from "@/lib/format";
import { Panel } from "@/components/economy/parts";

type Stage = "request" | "router" | "node" | "response";
interface Flight {
  id: string;
  model: string;
  nodeId: string | null;
  stage: Stage;
  state: string;
  at: number;
  /** True only for the labelled demo animation that plays when the network has no traffic. */
  demo: boolean;
}

const STAGES: { key: Stage; label: string; sub: string }[] = [
  { key: "request", label: "Request", sub: "/v1/chat/completions" },
  { key: "router", label: "Router", sub: "capability · availability · latency · reliability · price" },
  { key: "node", label: "Brain Node", sub: "vLLM / mock" },
  { key: "response", label: "Response", sub: "stream · receipt" },
];

const stageOf = (state: string): Stage => (state === "QUEUED" || state === "MATCHING" ? "router" : state === "ASSIGNED" || state === "STARTING" || state === "RUNNING" || state === "VERIFYING" ? "node" : "response");

/**
 * Animates the path of each inference job through the network. Driven by njob.* events on the
 * public SSE stream, so every pulse you see is a real job. When nothing has moved for a while and
 * no node is online, a clearly labelled DEMO pulse plays so the diagram still explains itself.
 */
export function RequestFlow({ nodesOnline }: { nodesOnline: number }) {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [live, setLive] = useState(false);
  const lastReal = useRef(0);

  useEffect(() => {
    const es = new EventSource("/api/network/stream");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      let e: NetworkEvent;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (e.type === "njob.progress") {
        // Progress frames are stripped of content on this stream; they still tell us the node is generating.
        lastReal.current = Date.now();
        setFlights((fs) => fs.map((f) => (f.id === e.jobId ? { ...f, stage: "node", state: `RUNNING · ${e.outputChars} chars`, nodeId: e.nodeId, at: Date.now() } : f)));
        return;
      }
      if (e.type !== "njob.updated") return;
      lastReal.current = Date.now();
      const j = e.job;
      setFlights((fs) => {
        const next = fs.filter((f) => f.id !== j.jobId && !f.demo);
        next.push({ id: j.jobId, model: j.model, nodeId: j.assignedNode, stage: stageOf(j.state), state: j.state, at: Date.now(), demo: false });
        return next.slice(-6);
      });
    };
    return () => es.close();
  }, []);

  // Expire finished flights; play a labelled demo pulse when the network is idle and empty.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setFlights((fs) => fs.filter((f) => !(f.stage === "response" && now - f.at > 4_000) && !(f.demo && now - f.at > 6_000)));
      if (nodesOnline === 0 && now - lastReal.current > 20_000) {
        setFlights((fs) => {
          if (fs.some((f) => f.demo)) return fs;
          return [...fs, { id: `demo-${now}`, model: "demo", nodeId: null, stage: "request", state: "DEMO", at: now, demo: true }];
        });
      }
    }, 1_000);
    return () => clearInterval(t);
  }, [nodesOnline]);

  // Advance demo pulses through the stages on a timer so the path reads left to right.
  useEffect(() => {
    const t = setInterval(() => {
      setFlights((fs) =>
        fs.map((f) => {
          if (!f.demo) return f;
          const age = Date.now() - f.at;
          const stage: Stage = age < 1_500 ? "request" : age < 3_000 ? "router" : age < 4_500 ? "node" : "response";
          return f.stage === stage ? f : { ...f, stage };
        }),
      );
    }, 250);
    return () => clearInterval(t);
  }, []);

  const demoShowing = flights.some((f) => f.demo);

  return (
    <Panel
      title="Request path"
      right={
        <span className={cx(demoShowing ? "text-warn" : live ? "text-ok" : "text-chalk/40")}>
          {demoShowing ? "DEMO NETWORK · no real traffic" : live ? "LIVE · real jobs only" : "connecting"}
        </span>
      }
    >
      <div className="relative grid grid-cols-4 gap-2">
        {STAGES.map((s, i) => {
          const here = flights.filter((f) => f.stage === s.key);
          const active = here.length > 0;
          return (
            <div key={s.key} className="relative">
              <div className={cx("rounded-[10px] border p-3 transition-colors duration-300", active ? (here.some((f) => f.demo) ? "border-warn/50 bg-warn/5" : "border-ok/50 bg-ok/5") : "border-chalk/10 bg-ink/30")}>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/45">{s.label}</div>
                <div className="mt-1 truncate font-mono text-[10.5px] text-chalk/35">{s.sub}</div>
                <div className="mt-3 min-h-[34px] space-y-1">
                  {here.slice(-3).map((f) => (
                    <div key={f.id} className={cx("truncate font-mono text-[10.5px]", f.demo ? "text-warn" : "text-chalk/80")}>
                      {f.demo ? "demo pulse" : f.model}
                      {f.nodeId && s.key !== "request" ? ` · ${f.nodeId}` : ""}
                      {!f.demo && <span className="text-chalk/40"> · {f.state}</span>}
                    </div>
                  ))}
                </div>
              </div>
              {i < STAGES.length - 1 && (
                <div className="pointer-events-none absolute -right-[7px] top-1/2 z-10 h-[2px] w-[12px] -translate-y-1/2 bg-chalk/15">
                  {active && <div className={cx("h-full w-full animate-pulse", here.some((f) => f.demo) ? "bg-warn" : "bg-ok")} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 font-mono text-[10.5px] leading-relaxed text-chalk/40">
        Each entry is one inference job as the coordinator reports it. Prompts and outputs never appear on this stream; only model, node id, state and sizes. The demo pulse is drawn by this page, not by any server record, and only when no node is online.
      </p>
    </Panel>
  );
}
