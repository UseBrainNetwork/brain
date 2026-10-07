import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MODEL_ALLOWLIST, modelSpec, type ModelSpec } from "../../models";
import type { GpuReport, JobPayload } from "../../protocol";
import type { GenerateResult, InferenceBackend } from "./types";

const run = promisify(execFile);

/**
 * vLLM backend. Runs the pinned `vllm/vllm-openai` image in an isolated Docker container and talks
 * to it over its OpenAI-compatible API on loopback. Only models from node/models.ts can be
 * launched, with exactly the arguments listed there; the job payload never reaches the command
 * line. One model is resident at a time in V1; switching models replaces the container.
 *
 * Isolation: loopback-only port, all capabilities dropped, no-new-privileges, memory cap, the
 * Hugging Face cache on a named volume so weights download once. HF_TOKEN is passed only when set.
 */
export const VLLM_IMAGE = "vllm/vllm-openai:v0.6.6";
const CONTAINER = "brain-vllm";
const PORT = 8000;
const BASE = `http://127.0.0.1:${PORT}`;

export class VllmBackend implements InferenceBackend {
  readonly kind = "vllm" as const;
  private loaded: string | null = null;
  private loading: Promise<boolean> | null = null;
  private supported: ModelSpec[];

  constructor(private opts: { gpus: GpuReport[]; models?: string[]; hfToken?: string; maxModelLen?: number }) {
    const vram = opts.gpus.reduce((s, g) => s + (g.vramTotalMb ?? 0), 0);
    this.supported = MODEL_ALLOWLIST.filter((m) => !m.mock && (!opts.models || opts.models.includes(m.id)) && (vram === 0 || m.minVramMb <= vram));
  }

  supportedModels() {
    return this.supported.map((m) => m.id);
  }
  loadedModels() {
    return this.loaded ? [this.loaded] : [];
  }

  async ensureLoaded(model: string, signal: AbortSignal): Promise<boolean> {
    if (this.loaded === model && (await this.healthy())) return false;
    if (this.loading) await this.loading.catch(() => undefined);
    if (this.loaded === model && (await this.healthy())) return false;
    this.loading = this.launch(model, signal);
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async launch(model: string, signal: AbortSignal): Promise<boolean> {
    const spec = modelSpec(model);
    if (!spec || spec.mock || !this.supported.some((m) => m.id === model)) throw new Error(`model ${model} is not allowlisted for this node`);
    await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    this.loaded = null;
    const args = [
      "run", "-d", "--name", CONTAINER, "--gpus", "all",
      "-p", `127.0.0.1:${PORT}:8000`,
      "-v", "brain-hf-cache:/root/.cache/huggingface",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ipc", "host",
      ...(this.opts.hfToken ? ["-e", `HUGGING_FACE_HUB_TOKEN=${this.opts.hfToken}`] : []),
      VLLM_IMAGE,
      "--model", spec.hf, "--served-model-name", spec.id,
      "--max-model-len", String(Math.min(spec.context, this.opts.maxModelLen ?? 8192)),
      "--gpu-memory-utilization", "0.90",
      ...(spec.vllmArgs ?? []),
    ];
    await run("docker", args);
    // Weights may need to download: allow up to 20 minutes, polling health.
    const until = Date.now() + 20 * 60_000;
    while (Date.now() < until) {
      if (signal.aborted) throw new Error("load cancelled");
      if (await this.healthy()) {
        this.loaded = model;
        return true;
      }
      const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER]).then((r) => r.stdout.trim()).catch(() => "false");
      if (state !== "true") {
        const logs = await run("docker", ["logs", "--tail", "20", CONTAINER]).then((r) => r.stderr + r.stdout).catch(() => "");
        throw new Error(`vLLM container exited: ${logs.slice(-400)}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error("vLLM did not become healthy in time");
  }

  private async healthy() {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async generate(job: JobPayload, onDelta: (delta: string, tokens: number) => void, signal: AbortSignal): Promise<GenerateResult> {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: job.model, messages: job.messages, max_tokens: job.maxTokens, temperature: job.temperature, stop: job.stop, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let tokens = 0;
    let finish: GenerateResult["finishReason"] = "stop";
    let usage: GenerateResult["usage"] | null = null;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.startsWith("data:")) continue;
        const payload = l.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices?.[0]?.delta?.content;
          if (typeof d === "string" && d) {
            content += d;
            tokens++;
            onDelta(d, tokens);
          }
          const fr = j.choices?.[0]?.finish_reason;
          if (fr === "length") finish = "length";
          if (j.usage && typeof j.usage.completion_tokens === "number") usage = { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens };
        } catch {
          /* partial line */
        }
      }
    }
    if (signal.aborted) finish = "cancelled";
    return { content, finishReason: finish, usage: usage ?? { prompt: Math.ceil(job.messages.reduce((s, m) => s + m.content.length, 0) / 4), completion: tokens } };
  }

  async shutdown() {
    await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    this.loaded = null;
  }
}
