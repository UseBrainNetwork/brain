"use client";

import { useEffect, useState } from "react";
import { NETWORK_MODELS, QWEN3_0_6B, type StageSpan } from "@/inference/config";
import { GGUF_EMBED, GGUF_FINAL_NORM, entryToF32 } from "@/inference/gguf";
import { createKv, embed, finalLogits, layerWeightsFrom, relativeRms, stageForward, topK } from "@/inference/llama";
import { headColumns } from "@/inference/protocol";
import { loadStageEntries } from "@/inference/shardLoader";
import { LlmStage } from "@/webgpu/llm";

interface Report {
  ok: boolean;
  model: string;
  layers: number;
  prefillRms: number;
  decodeRms: number;
  logitsRms: number;
  topMatch: boolean;
  gpuMsPrefill: number;
  gpuMsDecode: number;
  cpuMs: number;
  loadMs: number;
  bytes: number;
  error?: string;
}

/**
 * GPU-vs-CPU check on real weights: an end-to-end mini stage (embedding + N layers + head) so the
 * quantised kernels, the f16 cache, the embedding lookup and the output projection are all compared
 * against the f32 reference. `?layers=N&model=<id>`.
 */
export function LlmCheck() {
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    const say = (s: string) => setLog((l) => [...l, s]);
    (async () => {
      try {
        const qs = new URLSearchParams(location.search);
        const model = NETWORK_MODELS[qs.get("model") ?? ""] ?? QWEN3_0_6B;
        const layers = Number(qs.get("layers") ?? 2);
        const span: StageSpan = { stage: 0, layerFrom: 0, layerTo: layers, hasEmbed: true, hasHead: true };
        const t0 = performance.now();
        const entries = await loadStageEntries(model, span, (b, t) => say(`download ${(b / 1e6).toFixed(1)} / ${(t / 1e6).toFixed(1)} MB`));
        const loadMs = performance.now() - t0;
        say(`loaded ${(entries.bytesFetched / 1e6).toFixed(1)} MB in ${loadMs.toFixed(0)} ms`);
        const stage = await LlmStage.create(model, span, entries);
        say(`gpu stage ready, ${(stage.weightBytes / 1e6).toFixed(0)} MB on device`);

        const cfg = model.config;
        const tokens = Uint32Array.from([151644, 872, 198, 3838, 374, 279, 6722, 315, 9625, 30, 151645, 198]); // "<|im_start|>user\nWhat is the capital of France?<|im_end|>\n"
        const seq = tokens.length;
        const positions = Array.from({ length: seq }, (_, i) => i);

        const c0 = performance.now();
        const cpuLayers = Array.from({ length: layers }, (_, i) => layerWeightsFrom(entries, i));
        const kvs = cpuLayers.map(() => createKv(cfg, 64));
        const embedE = entries.get(GGUF_EMBED);
        const normW = entryToF32(entries.get(GGUF_FINAL_NORM));
        const cpuX = embed(embedE, cfg.hidden, tokens);
        stageForward(cfg, cpuLayers, kvs, cpuX, seq, positions);
        const cpuLogits = finalLogits(cfg, normW, embedE, cpuX.subarray((seq - 1) * cfg.hidden));
        const cpuMs = performance.now() - c0;

        // GPU: the head stage returns logits; compare the last column's logits and hidden via a second stage without the head.
        const g1 = await stage.forward("s1", { tokens }, seq, positions, 0);
        const gpuLast = g1.logits!.subarray((headColumns(seq) - 1) * cfg.vocab);
        const logitsRms = relativeRms(cpuLogits, gpuLast);
        const topMatch = topK(cpuLogits, 1).ids[0] === topK(gpuLast, 1).ids[0];
        say(`logits relative RMS ${logitsRms.toExponential(2)}, argmax ${topMatch ? "matches" : "DIFFERS"} (gpu ${g1.gpuMs.toFixed(1)} ms, cpu ${cpuMs.toFixed(0)} ms)`);

        // Hidden-state path: same layers without embed/head so the hop payload format is exercised too.
        const mid: StageSpan = { ...span, hasEmbed: false, hasHead: false };
        const stage2 = await LlmStage.create(model, mid, entries);
        const x0 = embed(embedE, cfg.hidden, tokens);
        const g2 = await stage2.forward("s2", { hidden: x0 }, seq, positions, 0);
        const prefillRms = relativeRms(cpuX, g2.hidden!);
        say(`prefill hidden relative RMS ${prefillRms.toExponential(2)} (gpu ${g2.gpuMs.toFixed(1)} ms)`);

        const nextTok = topK(cpuLogits, 1).ids[0];
        const cpuNext = embed(embedE, cfg.hidden, [nextTok]);
        const gpuNextIn = cpuNext.slice();
        stageForward(cfg, cpuLayers, kvs, cpuNext, 1, [seq]);
        const g3 = await stage2.forward("s2", { hidden: gpuNextIn }, 1, [seq], seq);
        const decodeRms = relativeRms(cpuNext, g3.hidden!);
        say(`decode hidden relative RMS ${decodeRms.toExponential(2)} (gpu ${g3.gpuMs.toFixed(1)} ms)`);

        // Rollback: a shorter expected cache length truncates instead of failing.
        const g4 = await stage2.forward("s2", { hidden: gpuNextIn }, 1, [seq], seq);
        say(`rollback re-run relative RMS ${relativeRms(g3.hidden!, g4.hidden!).toExponential(2)}`);

        stage.dropSession("s1");
        stage2.dropSession("s2");
        setReport({ ok: prefillRms < 2e-3 && decodeRms < 2e-3 && logitsRms < 2e-3 && topMatch, model: model.id, layers, prefillRms, decodeRms, logitsRms, topMatch, gpuMsPrefill: g1.gpuMs, gpuMsDecode: g3.gpuMs, cpuMs, loadMs, bytes: entries.bytesFetched });
      } catch (e) {
        say(`error: ${e instanceof Error ? e.message : String(e)}`);
        setReport({ ok: false, model: "", layers: 0, prefillRms: NaN, decodeRms: NaN, logitsRms: NaN, topMatch: false, gpuMsPrefill: 0, gpuMsDecode: 0, cpuMs: 0, loadMs: 0, bytes: 0, error: e instanceof Error ? e.message : String(e) });
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
