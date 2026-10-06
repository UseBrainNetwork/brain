"use client";

import { useEffect, useState } from "react";
import { SMOLLM2_135M } from "@/inference/config";
import { createKv, layerWeightsFrom, mulberry32, relativeRms, stageForward } from "@/inference/llama";
import { loadStageTensors } from "@/inference/shardLoader";
import { LlmStage } from "@/webgpu/llm";

interface Report {
  ok: boolean;
  layers: number;
  prefillRms: number;
  decodeRms: number;
  gpuMsPrefill: number;
  gpuMsDecode: number;
  cpuMs: number;
  loadMs: number;
  bytes: number;
  error?: string;
}

export function LlmCheck() {
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    const say = (s: string) => setLog((l) => [...l, s]);
    (async () => {
      try {
        const model = SMOLLM2_135M;
        const layers = Number(new URLSearchParams(location.search).get("layers") ?? 2);
        const span = { stage: 0, layerFrom: 0, layerTo: layers };
        const t0 = performance.now();
        const tensors = await loadStageTensors(model, span, (b, t) => say(`download ${(b / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB`));
        const loadMs = performance.now() - t0;
        say(`loaded ${tensors.bytesFetched} bytes in ${loadMs.toFixed(0)} ms`);
        const stage = await LlmStage.create(model, span, tensors);
        say(`gpu stage ready, ${(stage.weightBytes / 1e6).toFixed(0)} MB f32 on device`);

        const cfg = model.config;
        const seq = 12;
        const rnd = mulberry32(7);
        const x = Float32Array.from({ length: seq * cfg.hidden }, () => (rnd() - 0.5) * 2);
        const positions = Array.from({ length: seq }, (_, i) => i);

        const c0 = performance.now();
        const cpuLayers = Array.from({ length: layers }, (_, i) => layerWeightsFrom(tensors, i));
        const kvs = cpuLayers.map(() => createKv(cfg, 64));
        const cpuX = x.slice();
        stageForward(cfg, cpuLayers, kvs, cpuX, seq, positions);
        const cpuMs = performance.now() - c0;

        const g1 = await stage.forward("s1", x, seq, positions, 0);
        const prefillRms = relativeRms(cpuX, g1.hidden);
        say(`prefill relative RMS ${prefillRms.toExponential(2)} (gpu ${g1.gpuMs.toFixed(1)} ms, cpu ${cpuMs.toFixed(0)} ms)`);

        const next = Float32Array.from({ length: cfg.hidden }, () => (rnd() - 0.5) * 2);
        const cpuNext = next.slice();
        stageForward(cfg, cpuLayers, kvs, cpuNext, 1, [seq]);
        const g2 = await stage.forward("s1", next, 1, [seq], seq);
        const decodeRms = relativeRms(cpuNext, g2.hidden);
        say(`decode relative RMS ${decodeRms.toExponential(2)} (gpu ${g2.gpuMs.toFixed(1)} ms)`);
        stage.dropSession("s1");
        setReport({ ok: prefillRms < 1e-4 && decodeRms < 1e-4, layers, prefillRms, decodeRms, gpuMsPrefill: g1.gpuMs, gpuMsDecode: g2.gpuMs, cpuMs, loadMs, bytes: tensors.bytesFetched });
      } catch (e) {
        say(`error: ${e instanceof Error ? e.message : String(e)}`);
        setReport({ ok: false, layers: 0, prefillRms: NaN, decodeRms: NaN, gpuMsPrefill: 0, gpuMsDecode: 0, cpuMs: 0, loadMs: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);
  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <h1>llm-check</h1>
      <pre>{log.join("\n")}</pre>
      {report && <pre id="report">{JSON.stringify(report)}</pre>}
    </main>
  );
}
