import { execFile, spawn } from "node:child_process";
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
  private loadingModel: string | null = null;
  private supported: ModelSpec[];

  private log: (line: string) => void;

  constructor(private opts: { gpus: GpuReport[]; models?: string[]; hfToken?: string; maxModelLen?: number; log?: (line: string) => void }) {
    const vram = opts.gpus.reduce((s, g) => s + (g.vramTotalMb ?? 0), 0);
    this.supported = MODEL_ALLOWLIST.filter((m) => !m.mock && (!opts.models || opts.models.includes(m.id)) && (vram === 0 || m.minVramMb <= vram));
    this.log = opts.log ?? (() => undefined);
  }

  /**
   * `docker run` pulls a missing image silently, which on first start means ten minutes of nothing
   * on screen while ~10 GB download. Pull explicitly and relay Docker's progress lines instead.
   */
  private async pullImage(): Promise<void> {
    const have = await run("docker", ["image", "inspect", VLLM_IMAGE]).then(() => true).catch(() => false);
    if (have) return;
    this.log(`vllm: pulling ${VLLM_IMAGE} (about 10 GB, first start only)`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn("docker", ["pull", VLLM_IMAGE], { stdio: ["ignore", "pipe", "pipe"] });
      let last = 0;
      const relay = (chunk: Buffer) => {
        const now = Date.now();
        if (now - last < 10_000) return; // one line every ten seconds, not Docker's full ticker
        last = now;
        const line = chunk.toString().trim().split("\n").pop();
        if (line) this.log(`vllm: pull ${line}`);
      };
      p.stdout.on("data", relay);
      p.stderr.on("data", relay);
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker pull exited ${code}`))));
    });
    this.log(`vllm: image ready`);
  }

  supportedModels() {
    return this.supported.map((m) => m.id);
  }
  loadedModels() {
    return this.loaded ? [this.loaded] : [];
  }

  /**
   * Make `model` resident. Loading is independent of the job that asked for it: if the job is
   * aborted (deadline, cancel) while weights are still downloading, the job fails but the load keeps
   * going, so the next job finds the model ready instead of restarting a multi-gigabyte download.
   * Only one load runs at a time; concurrent callers wait on it.
   */
  async ensureLoaded(model: string, signal: AbortSignal): Promise<boolean> {
    if (this.loaded === model && (await this.healthy())) return false;
    if (!this.loading || this.loadingModel !== model) {
      if (this.loading) await this.loading.catch(() => undefined); // a different model: let it settle first
      if (this.loaded === model && (await this.healthy())) return false;
      this.loadingModel = model;
      this.loading = this.launch(model).finally(() => {
        this.loading = null;
        this.loadingModel = null;
      });
    }
    const loading = this.loading;
    if (signal.aborted) throw new Error("load cancelled");
    return await new Promise<boolean>((resolve, reject) => {
      const onAbort = () => reject(new Error("load cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      loading.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Start loading the first supported model now so the first job (the coordinator's benchmark) finds it ready. */
  prewarm(model = this.supported[0]?.id): void {
    if (!model) return;
    void this.ensureLoaded(model, new AbortController().signal).catch(() => undefined);
  }

  /** True when a container from a previous agent run is already serving `model` and healthy. */
  private async adopt(model: string): Promise<boolean> {
    if (!(await this.healthy())) return false;
    try {
      const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      const j = (await r.json()) as { data?: { id: string }[] };
      return Boolean(j.data?.some((m) => m.id === model));
    } catch {
      return false;
    }
  }

  private async launch(model: string): Promise<boolean> {
    const spec = modelSpec(model);
    if (!spec || spec.mock || !this.supported.some((m) => m.id === model)) throw new Error(`model ${model} is not allowlisted for this node`);
    // Agent restarted but the container from last time is still up with this model: keep it.
    if (await this.adopt(model)) {
      this.loaded = model;
      return false;
    }
    await this.pullImage();
    await run("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    this.loaded = null;
    // A model whose floor exceeds one card is sharded across the GPUs present (power of two, as vLLM requires).
    const perGpu = Math.max(0, ...this.opts.gpus.map((g) => g.vramTotalMb ?? 0));
    let tp = 1;
    if (perGpu > 0 && spec.minVramMb > perGpu) while (tp * 2 <= this.opts.gpus.length && tp * perGpu < spec.minVramMb) tp *= 2;
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
      ...(tp > 1 ? ["--tensor-parallel-size", String(tp)] : []),
      ...(spec.vllmArgs ?? []),
    ];
    await run("docker", args);
    this.log(`vllm: container ${CONTAINER} started, loading ${spec.id} (weights download to the brain-hf-cache volume on first use)`);
    // Weights may need to download: allow up to 20 minutes, polling health.
    const started = Date.now();
    const until = started + 20 * 60_000;
    let nextStatus = started + 30_000;
    while (Date.now() < until) {
      if (await this.healthy()) {
        this.loaded = model;
        this.log(`vllm: ${spec.id} ready after ${Math.round((Date.now() - started) / 1000)}s`);
        return true;
      }
      if (Date.now() >= nextStatus) {
        nextStatus += 30_000;
        const tail = await run("docker", ["logs", "--tail", "1", CONTAINER]).then((r) => (r.stderr + r.stdout).trim().split("\n").pop() ?? "").catch(() => "");
        this.log(`vllm: still loading ${spec.id} (${Math.round((Date.now() - started) / 1000)}s)${tail ? ` · ${tail.slice(0, 160)}` : ""}`);
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
