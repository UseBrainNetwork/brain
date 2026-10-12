import { isImportedId, matchServedModel, modelSpec } from "../../models";
import type { Backend, ImportOffer, JobPayload } from "../../protocol";
import type { GenerateResult, InferenceBackend } from "./types";

/**
 * Backend for an OpenAI-compatible inference server the operator already runs on this machine:
 *
 *   llama.cpp   `llama-server -m model.gguf --alias qwen2.5-1.5b-instruct --port 8080`
 *   Ollama      `ollama serve` (default port 11434; models pulled on demand)
 *   mlx-lm      `mlx_lm.server --model mlx-community/Qwen2.5-1.5B-Instruct-4bit --port 8080`
 *   exo         `exo` (default port 52415; one endpoint for a cluster of home devices)
 *
 * The agent only ever talks to loopback or an address the operator set; the job payload goes into
 * the request body, never a command line. Which allowlisted models the node can serve is read from
 * the server's own /v1/models list and mapped by name (see matchServedModel), or pinned with
 * BRAIN_NODE_MODEL_MAP="qwen/qwen2.5-1.5b-instruct=qwen2.5:1.5b-instruct,...". Anything the server
 * lists that is not allowlisted is ignored; the coordinator never routes it.
 *
 * Ollama can pull a missing allowlisted model on request; the other servers must already have the
 * model loaded, so ensureLoaded only confirms it is listed.
 *
 * Imported models (`hf/<org>/<repo>`): Ollama pulls them as `hf.co/<org>/<repo>:<quant>` when the
 * coordinator offers one and the operator opted in (pullImports). The other servers serve the
 * GGUF the operator started them with; its name maps onto the imported id by repository or file
 * name (matchServedModel), or is pinned with BRAIN_NODE_MODEL_MAP="hf/org/repo=<served name>".
 */
export const DEFAULT_PORTS: Record<Exclude<Backend, "mock" | "vllm">, number> = { llamacpp: 8080, ollama: 11434, mlx: 8080, exo: 52415 };

export interface LocalBackendOptions {
  kind: Exclude<Backend, "mock" | "vllm">;
  /** Base URL of the server, e.g. http://127.0.0.1:11434. */
  baseUrl: string;
  /** Allowlisted ids the operator wants to serve (default: everything the server lists that maps). */
  models?: string[];
  /** Explicit allowlisted-id → served-name pins. */
  modelMap?: Record<string, string>;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

const OLLAMA_NAMES: Record<string, string> = {
  "qwen/qwen2.5-1.5b-instruct": "qwen2.5:1.5b-instruct",
  "qwen/qwen2.5-3b-instruct": "qwen2.5:3b-instruct",
  "qwen/qwen2.5-7b-instruct": "qwen2.5:7b-instruct",
  "mistralai/mistral-7b-instruct-v0.3": "mistral:7b-instruct-v0.3",
  "meta-llama/llama-3.1-8b-instruct": "llama3.1:8b-instruct-q4_K_M",
  "qwen/qwen2.5-14b-instruct": "qwen2.5:14b-instruct",
  "qwen/qwen2.5-32b-instruct": "qwen2.5:32b-instruct",
  "qwen/qwen2.5-coder-32b-instruct": "qwen2.5-coder:32b-instruct",
  "qwen/qwen2.5-72b-instruct": "qwen2.5:72b-instruct",
  "deepseek-ai/deepseek-r1-distill-qwen-32b": "deepseek-r1:32b",
  "deepseek-ai/deepseek-r1-distill-llama-8b": "deepseek-r1:8b",
  "meta-llama/llama-3.3-70b-instruct": "llama3.3:70b-instruct-q4_K_M",
};

const OLLAMA_IDS: Record<string, string> = Object.fromEntries(Object.entries(OLLAMA_NAMES).map(([id, tag]) => [tag, id]));

export class LocalServerBackend implements InferenceBackend {
  readonly kind: Backend;
  private served = new Map<string, string>(); // allowlisted id → name the server uses
  private log: (line: string) => void;
  private fetch: typeof fetch;
  private base: string;

  constructor(private opts: LocalBackendOptions) {
    this.kind = opts.kind;
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.log = opts.log ?? (() => undefined);
    this.fetch = opts.fetchImpl ?? fetch;
    this.applyPins();
  }

  /** Operator pins. Imported ids pinned before the coordinator has sent the table are applied on the next discover(). */
  private applyPins() {
    for (const [id, name] of Object.entries(this.opts.modelMap ?? {})) if (modelSpec(id) && !modelSpec(id)?.mock && !this.served.has(id)) this.served.set(id, name);
  }

  /** Reads /v1/models and maps what the server serves onto the allowlist and the imported table. Safe to call repeatedly. */
  async discover(): Promise<string[]> {
    this.applyPins();
    let names: string[] = [];
    try {
      const r = await this.fetch(`${this.base}/v1/models`, { signal: AbortSignal.timeout(4_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { data?: { id?: string }[] };
      names = (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
    } catch (e) {
      this.log(`${this.kind}: cannot list models at ${this.base} (${e instanceof Error ? e.message : e})`);
      return this.supportedModels();
    }
    for (const name of names) {
      // Ollama tags like "deepseek-r1:32b" do not carry the allowlisted name; the known-tag table covers them.
      const spec = matchServedModel(name) ?? (this.kind === "ollama" ? modelSpec(OLLAMA_IDS[name.replace(/:latest$/, "")] ?? "") : undefined);
      if (!spec || this.served.has(spec.id)) continue;
      // BRAIN_NODE_MODELS restricts allowlisted ids; imported models are governed by the opt-in flag instead.
      if (this.opts.models && !spec.imported && !this.opts.models.includes(spec.id)) continue;
      this.served.set(spec.id, name);
    }
    // An imported model whose record disappeared from the coordinator's table is no longer routable; stop advertising it.
    for (const id of this.served.keys()) if (isImportedId(id) && !modelSpec(id)) this.served.delete(id);
    // Ollama can fetch what is not there yet; advertise the requested allowlisted ids it knows names for.
    if (this.kind === "ollama") for (const id of this.opts.models ?? []) if (!this.served.has(id) && OLLAMA_NAMES[id]) this.served.set(id, OLLAMA_NAMES[id]);
    return this.supportedModels();
  }

  supportedModels() {
    return [...this.served.keys()];
  }
  loadedModels() {
    // A local server keeps what it has loaded; we report what it lists, which is what it can answer for.
    return [...this.served.keys()];
  }

  private servedName(model: string): string {
    const name = this.served.get(model);
    if (!name) throw new Error(`model ${model} is not served by this ${this.kind} server`);
    return name;
  }

  async ensureLoaded(model: string, signal: AbortSignal): Promise<boolean> {
    if (!this.served.has(model)) await this.discover();
    const name = this.servedName(model);
    if (this.kind !== "ollama") return false;
    // Ollama: pull if the tag is missing. /api/pull streams progress lines; we only need the end.
    const have = await this.fetch(`${this.base}/api/tags`, { signal: AbortSignal.timeout(4_000) })
      .then((r) => r.json() as Promise<{ models?: { name?: string; model?: string }[] }>)
      .then((j) => (j.models ?? []).some((m) => m.name === name || m.model === name || m.name === `${name}:latest`))
      .catch(() => false);
    if (have) return false;
    this.log(`ollama: pulling ${name} (first use)`);
    const r = await this.fetch(`${this.base}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: false }), signal });
    if (!r.ok) throw new Error(`ollama pull ${name}: HTTP ${r.status}`);
    this.log(`ollama: ${name} ready`);
    return true;
  }

  prewarm(model?: string): void {
    const id = model ?? this.supportedModels()[0];
    if (!id) return;
    void this.ensureLoaded(id, new AbortController().signal).catch(() => undefined);
  }

  private pulling = new Set<string>();

  /**
   * Imported models the coordinator asked this node to fetch. Ollama pulls straight from Hugging
   * Face as `hf.co/<org>/<repo>:<quant>`; one pull at a time, each a request to the operator's own
   * Ollama with a repository path and a quantisation tag the coordinator resolved. Other servers
   * cannot fetch on request; the offer is logged so the operator can load the file themselves.
   */
  async pullImports(offers: ImportOffer[], log: (line: string) => void): Promise<string[]> {
    const done: string[] = [];
    for (const o of offers) {
      if (this.served.has(o.model) || this.pulling.has(o.model) || !modelSpec(o.model)) continue;
      if (this.kind !== "ollama") {
        log(`import offered: ${o.model} (${o.file}, ${(o.sizeBytes / 1e9).toFixed(1)} GB). ${this.kind} cannot pull on request; load it yourself and pin BRAIN_NODE_MODEL_MAP="${o.model}=<served name>".`);
        continue;
      }
      const name = `hf.co/${o.repo}:${o.quant}`;
      this.pulling.add(o.model);
      try {
        log(`ollama: pulling ${name} for ${o.model} (${(o.sizeBytes / 1e9).toFixed(1)} GB)`);
        const r = await this.fetch(`${this.base}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: false }), signal: AbortSignal.timeout(2 * 3_600_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        this.served.set(o.model, name);
        done.push(o.model);
        log(`ollama: ${o.model} ready as ${name}`);
      } catch (e) {
        log(`ollama: pull of ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.pulling.delete(o.model);
      }
    }
    return done;
  }

  async generate(job: JobPayload, onDelta: (delta: string, tokens: number) => void, signal: AbortSignal): Promise<GenerateResult> {
    const res = await this.fetch(`${this.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.servedName(job.model), messages: job.messages, max_tokens: job.maxTokens, temperature: job.temperature, stop: job.stop, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`${this.kind} ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    // Servers that omit usage (older llama.cpp builds): count streamed deltas, estimate the prompt.
    return { content, finishReason: finish, usage: usage ?? { prompt: Math.ceil(job.messages.reduce((s, m) => s + m.content.length, 0) / 4), completion: tokens } };
  }

  async shutdown() {
    // The server is the operator's; the agent never starts or stops it.
  }
}