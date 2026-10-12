import "server-only";
import { importedIdFor, importedModels, setImportedModels, type ComputeClass, type ImportedFile, type ModelSpec } from "@/node/models";
import { routableNativeNodes, type NativeNode } from "@/services/coordinator/registry";
import { getStore } from "@/services/store";

/**
 * Bring your own model. A developer points the network at a public Hugging Face repository; the
 * coordinator resolves it once to exactly one GGUF file, records the file, its size and what the
 * repository says about itself, and from then on routes `hf/<org>/<repo>` like any other node
 * model. Nodes that opted in (BRAIN_NODE_IMPORTS=1) pull the file through their own inference
 * server; nothing a developer sends reaches a node as anything but a repository path and a file name
 * the coordinator already checked against Hugging Face.
 *
 * What is recorded here came from Hugging Face's API: parameter count and context from the GGUF
 * header it parsed, the license tag, the file size. The VRAM figure is a requirement derived from
 * the file size, shown as such. Nothing is measured until a node serves the model, and the usual
 * rules then apply: coordinator-timed speed, canaries, redundant execution, node-reported receipts.
 *
 * Limits: text generation only (the network's nodes run chat servers), models with a chat template
 * (canaries assume instruction following; a base model would fail them through no fault of the
 * node), single-file GGUFs (Ollama and llama.cpp pull one file), public repositories (nodes have no
 * token to offer), and a total count so the table stays a table.
 */
export interface ImportedModel {
  /** `hf/<org>/<repo>`, lower-cased. */
  id: string;
  /** Repository id in Hugging Face's casing. */
  repo: string;
  file: ImportedFile;
  /** "20.9B" from the GGUF header's parameter count. */
  params: string;
  context: number;
  license: string;
  /** Requirement derived from file size; not a measurement. */
  minVramMb: number;
  createdAt: number;
  lastRequestedAt: number;
  /** Import requests for this model (people asking for it, not inference calls). */
  requests: number;
  /** Hashed IP of the first requester. Never exposed. */
  requestedBy: string;
}

export type PublicImportedModel = Omit<ImportedModel, "requestedBy">;
export const publicImportedModel = ({ requestedBy: _r, ...m }: ImportedModel): PublicImportedModel => {
  void _r;
  return m;
};

export type ImportError = "invalid_source" | "not_found" | "gated" | "not_text_generation" | "no_chat_template" | "no_gguf" | "no_single_file_gguf" | "unparsed_gguf" | "too_large" | "file_not_found" | "limit_reached" | "upstream_error";

export type ImportResult = { ok: true; model: ImportedModel; created: boolean } | { ok: false; code: ImportError; message: string; suggestions?: { repo: string; downloads: number | null }[] };

export const MAX_IMPORTS = () => {
  const v = Number(process.env.BRAIN_IMPORTS_MAX);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 300;
};
/** Nothing larger than this is importable; no node on the network could hold it in one piece. */
export const MAX_FILE_BYTES = 80e9;
const HF_TIMEOUT_MS = 8_000;

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `https://huggingface.co/org/repo/tree/main`, `hf.co/org/repo`, `hf:org/repo`, `hf/org/repo`, `org/repo` → "org/repo". */
export function parseSource(input: string): string | null {
  let s = String(input ?? "").trim();
  if (!s || s.length > 400) return null;
  s = s.replace(/^https?:\/\//i, "");
  // A host that is not Hugging Face is not a repository id.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s) && !/^(www\.)?(huggingface\.co|hf\.co)\//i.test(s)) return null;
  s = s.replace(/^(www\.)?(huggingface\.co|hf\.co)\//i, "").replace(/^hf[:/]/i, "");
  s = s.split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  return REPO_RE.test(repo) ? repo : null;
}

/** "Qwen2.5-7B-Instruct-Q4_K_M.gguf" → "Q4_K_M"; "model.Q8_0.gguf" → "Q8_0"; "gpt-oss-20b-MXFP4.gguf" → "MXFP4". */
export function quantOf(file: string): string {
  const stem = file.replace(/\.gguf$/i, "");
  const m = /[-._]([A-Za-z]{1,5}\d[A-Za-z0-9_]*)$/.exec(stem);
  return (m?.[1] ?? stem.split(/[-._]/).pop() ?? "").toUpperCase();
}

/** Default quantisation order when the requester did not name a file: 4-bit K-quants first, then what llama.cpp ships for MoE, then up. */
const QUANT_PREFERENCE = ["Q4_K_M", "Q4_K_S", "MXFP4", "Q5_K_M", "IQ4_XS", "Q4_0", "Q5_K_S", "Q6_K", "Q8_0", "Q3_K_M", "F16", "BF16"];

const isSingleFileGguf = (name: string) => /\.gguf$/i.test(name) && !/-\d{5}-of-\d{5}\.gguf$/i.test(name) && !/mmproj|eagle|draft|vocab/i.test(name);

export function chooseFile(files: { name: string; size: number }[], want?: string): { name: string; size: number } | null {
  const ggufs = files.filter((f) => isSingleFileGguf(f.name) && f.size > 0);
  if (!ggufs.length) return null;
  if (want) {
    const w = want.toLowerCase();
    return ggufs.find((f) => f.name.toLowerCase() === w) ?? ggufs.find((f) => quantOf(f.name).toLowerCase() === w) ?? null;
  }
  for (const q of QUANT_PREFERENCE) {
    const hit = ggufs.find((f) => quantOf(f.name) === q);
    if (hit) return hit;
  }
  const sorted = [...ggufs].sort((a, b) => a.size - b.size);
  return sorted[sorted.length >> 1];
}

/** Weights in memory plus KV cache and runtime headroom. A requirement for routing, labelled as such on /models. */
export const minVramMbFor = (sizeBytes: number) => Math.ceil((sizeBytes / 1_048_576) * 1.1) + 1_536;

export const formatParams = (n: number) => {
  if (!(n > 0)) return "0";
  if (n >= 1e12) return `${trim(n / 1e12)}T`;
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e3)}K`;
};
const trim = (x: number) => (Math.round(x * 10) / 10).toString();

const classesFor = (minVramMb: number): ComputeClass[] => (minVramMb <= 10_000 ? ["CONSUMER", "PRO", "DATACENTER"] : minVramMb <= 34_000 ? ["PRO", "DATACENTER"] : ["DATACENTER"]);

export function specOf(m: ImportedModel): ModelSpec {
  return { id: m.id, name: m.repo, hf: m.repo, params: m.params, context: m.context, minVramMb: m.minVramMb, classes: classesFor(m.minVramMb), license: m.license, imported: m.file };
}

/* ------------------------------------------------------------------------------- Hugging Face */

interface HfModel {
  id: string;
  private?: boolean;
  gated?: boolean | string;
  pipeline_tag?: string;
  tags?: string[];
  gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string };
  siblings?: { rfilename: string; size?: number }[];
  downloads?: number;
}

export type Resolved = { ok: true; hf: HfModel; file: { name: string; size: number } } | { ok: false; code: ImportError; message: string; suggestions?: { repo: string; downloads: number | null }[] };

/** One round trip to Hugging Face (two when the repo has no GGUF and we look for quantisations of it). Pure given `fetchImpl`. */
export async function resolveRepo(repo: string, want: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Resolved> {
  let r: Response;
  try {
    r = await fetchImpl(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(HF_TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch (e) {
    return { ok: false, code: "upstream_error", message: `Hugging Face did not answer (${e instanceof Error ? e.message : String(e)}).` };
  }
  if (r.status === 404) return { ok: false, code: "not_found", message: `No public repository ${repo} on Hugging Face.` };
  if (r.status === 401 || r.status === 403) return { ok: false, code: "gated", message: `${repo} is gated or private. Nodes have no token to offer; import a public repository.` };
  if (!r.ok) return { ok: false, code: "upstream_error", message: `Hugging Face answered ${r.status}.` };
  const hf = (await r.json()) as HfModel;
  if (hf.private || hf.gated) return { ok: false, code: "gated", message: `${hf.id} is gated or private. Nodes have no token to offer; import a public repository.` };
  const pipeline = hf.pipeline_tag ?? null;
  if (pipeline && pipeline !== "text-generation") return { ok: false, code: "not_text_generation", message: `${hf.id} is a ${pipeline} model. Brain Nodes serve text generation; image, audio and embedding models are not routed.` };
  const files = (hf.siblings ?? []).map((s) => ({ name: s.rfilename, size: Number(s.size) || 0 }));
  if (!files.some((f) => isSingleFileGguf(f.name))) {
    if (files.some((f) => /\.gguf$/i.test(f.name))) return { ok: false, code: "no_single_file_gguf", message: `${hf.id} ships its GGUF in parts or as a projector only. Import a repository with a single-file GGUF.` };
    const suggestions = await quantisationsOf(hf.id, fetchImpl);
    return {
      ok: false,
      code: "no_gguf",
      message: suggestions.length ? `${hf.id} has no GGUF files. GGUF quantisations of it: ${suggestions.map((s) => s.repo).join(", ")}. Import one of those.` : `${hf.id} has no GGUF files, and Hugging Face lists no GGUF quantisation of it. Nodes run llama.cpp-family servers, which need GGUF.`,
      suggestions,
    };
  }
  if (!hf.gguf?.total) return { ok: false, code: "unparsed_gguf", message: `Hugging Face has not parsed ${hf.id}'s GGUF header yet, so its parameter count is unknown. Try again later.` };
  if (!hf.gguf.chat_template && !(hf.tags ?? []).includes("conversational")) return { ok: false, code: "no_chat_template", message: `${hf.id} has no chat template. Brain Nodes serve chat; import an instruct or chat fine-tune.` };
  const file = chooseFile(files, want);
  if (!file) return { ok: false, code: "file_not_found", message: want ? `${hf.id} has no GGUF file or quantisation named ${want}.` : `${hf.id} has no usable single-file GGUF.` };
  if (file.size > MAX_FILE_BYTES) return { ok: false, code: "too_large", message: `${file.name} is ${(file.size / 1e9).toFixed(0)} GB; no node holds that in one piece.` };
  return { ok: true, hf, file };
}

async function quantisationsOf(repo: string, fetchImpl: typeof fetch): Promise<{ repo: string; downloads: number | null }[]> {
  try {
    const r = await fetchImpl(`https://huggingface.co/api/models?filter=gguf,base_model:quantized:${encodeURIComponent(repo)}&sort=downloads&direction=-1&limit=5`, { signal: AbortSignal.timeout(HF_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const j = (await r.json()) as HfModel[];
    return (Array.isArray(j) ? j : []).map((m) => ({ repo: m.id, downloads: typeof m.downloads === "number" ? m.downloads : null }));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------------------------- store */

const KIND = "model" as const;
const store = () => getStore();
const cache = globalThis as typeof globalThis & { __brainImports?: { at: number; value: Promise<ImportedModel[]> } };
const CACHE_MS = 10_000;

export function listImportedModels(maxAgeMs = CACHE_MS): Promise<ImportedModel[]> {
  const now = Date.now();
  if (!cache.__brainImports || now - cache.__brainImports.at > maxAgeMs) {
    const value = store()
      .listDocs<ImportedModel>(KIND, { limit: 1_000 })
      .then((xs) => xs.filter((m) => m && typeof m.id === "string" && m.file));
    cache.__brainImports = { at: now, value };
    value.catch(() => (cache.__brainImports = undefined));
  }
  return cache.__brainImports.value;
}
const invalidate = () => (cache.__brainImports = undefined);

/**
 * Loads the imported table into node/models so `modelSpec`/`isAllowedModel` see it. Every path
 * that reads a model id calls this first; it is a cached read, so the cost is a map copy. Never
 * throws: a store outage leaves the previous table in place (or none, on a cold instance), and the
 * request then fails as "unknown model" rather than 500.
 */
export async function syncImportedModels(): Promise<ModelSpec[]> {
  try {
    const specs = (await listImportedModels()).map(specOf);
    setImportedModels(specs);
    return specs;
  } catch (e) {
    console.warn("[imports] sync failed", e instanceof Error ? e.message : e);
    return importedModels();
  }
}

export const getImportedModel = async (id: string) => (await listImportedModels()).find((m) => m.id === id) ?? null;

/**
 * Import or re-request a model. Idempotent per repository: a second request for the same repo
 * bumps its request count and recency (which is what orders the offers nodes receive) and returns
 * the existing record; a different file for the same repo is not a second model.
 */
export async function importModel(source: string, requestedBy: string, opts: { file?: string; fetchImpl?: typeof fetch } = {}, now = Date.now()): Promise<ImportResult> {
  const repo = parseSource(source);
  if (!repo) return { ok: false, code: "invalid_source", message: "Send a Hugging Face repository: a huggingface.co URL or org/repo." };
  const id = importedIdFor(repo);
  const existing = await getImportedModel(id);
  if (existing) {
    existing.requests += 1;
    existing.lastRequestedAt = now;
    await store().putDoc(KIND, id, existing, { at: now, key: "hf" });
    invalidate();
    return { ok: true, model: existing, created: false };
  }
  const all = await listImportedModels();
  if (all.length >= MAX_IMPORTS()) return { ok: false, code: "limit_reached", message: `The import table is full (${MAX_IMPORTS()} models). Ask for one already listed, or wait for unused ones to be retired.` };
  const res = await resolveRepo(repo, opts.file, opts.fetchImpl);
  if (!res.ok) return res;
  const canonical = importedIdFor(res.hf.id);
  const dup = canonical !== id ? await getImportedModel(canonical) : null;
  if (dup) return { ok: true, model: dup, created: false };
  const license = (res.hf.tags ?? []).find((t) => t.startsWith("license:"))?.slice(8) ?? "unknown";
  const m: ImportedModel = {
    id: canonical,
    repo: res.hf.id,
    file: { repo: res.hf.id, file: res.file.name, quant: quantOf(res.file.name), sizeBytes: res.file.size, architecture: res.hf.gguf?.architecture ?? null },
    params: formatParams(res.hf.gguf?.total ?? 0),
    context: Math.min(32_768, Math.max(2_048, res.hf.gguf?.context_length ?? 8_192)),
    license,
    minVramMb: minVramMbFor(res.file.size),
    createdAt: now,
    lastRequestedAt: now,
    requests: 1,
    requestedBy,
  };
  await store().putDoc(KIND, canonical, m, { at: now, key: "hf" });
  invalidate();
  await syncImportedModels();
  return { ok: true, model: m, created: true };
}

/* -------------------------------------------------------------------------------------- nodes */

export interface ImportOffer {
  model: string;
  repo: string;
  file: string;
  quant: string;
  sizeBytes: number;
}

/** Node memory the coordinator will size against: reported GPU memory, else system RAM (CPU inference still serves). */
export const nodeMemoryMb = (n: NativeNode): number | null => {
  const vram = n.reported.hardware.gpus.reduce<number | null>((s, g) => (g.vramTotalMb == null ? s : (s ?? 0) + g.vramTotalMb), null);
  return vram ?? (n.reported.hardware.ramTotalMb > 0 ? n.reported.hardware.ramTotalMb : null);
};

/**
 * Which imported models a node that opted in should fetch: the most recently requested ones that
 * fit its memory and its disk budget and that it does not already serve. Three at a time so a node
 * is not asked to download the whole table. Reported hardware is a hard filter here, as in routing.
 */
export function importOffersFor(n: NativeNode, models: ImportedModel[], limit = 3): ImportOffer[] {
  const imports = n.reported.capabilities.imports;
  if (!imports || n.reported.hardware.mock) return [];
  const mem = nodeMemoryMb(n);
  if (mem == null) return [];
  const budgetBytes = Math.max(0, imports.diskBudgetGb) * 1e9;
  const diskFree = n.reported.hardware.diskFreeGb;
  const have = new Set(n.reported.capabilities.supportedModels);
  let spent = 0;
  const out: ImportOffer[] = [];
  for (const m of [...models].sort((a, b) => b.lastRequestedAt - a.lastRequestedAt)) {
    if (have.has(m.id) || m.minVramMb > mem) continue;
    if (spent + m.file.sizeBytes > budgetBytes) continue;
    if (diskFree != null && m.file.sizeBytes / 1e9 > diskFree - 2) continue;
    spent += m.file.sizeBytes;
    out.push({ model: m.id, repo: m.repo, file: m.file.file, quant: m.file.quant, sizeBytes: m.file.sizeBytes });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------- views */

/** What /v1/models/import answers: the record, who serves it now, and how to call it. */
export async function importView(m: ImportedModel, created: boolean) {
  const live = (await routableNativeNodes().catch(() => [])).filter((n) => n.state === "ONLINE" || n.state === "BUSY");
  const serving = live.filter((n) => n.reported.capabilities.supportedModels.includes(m.id));
  const status = serving.length ? "available" : "waiting_for_node";
  return {
    model: { ...publicImportedModel(m), status, nodes_online: serving.length },
    created,
    use: {
      model: m.id,
      curl: `curl -s https://brainnetwork.app/v1/chat/completions -H "authorization: Bearer $BRAIN_API_KEY" -H 'content-type: application/json' -d '{"model":"${m.id}","messages":[{"role":"user","content":"hello"}]}'`,
    },
    note:
      status === "available"
        ? `${serving.length} node${serving.length === 1 ? "" : "s"} serve this model now. Requests naming it go only to them.`
        : `No node serves this model yet. Nodes that opted in (BRAIN_NODE_IMPORTS=1) with ${Math.ceil(m.minVramMb / 1024)} GB of memory are being asked to pull it. A request before then is refused with the routing reason; it is never answered by a different model.`,
  };
}

/** Public table for /models and /api/models/imports: records plus live node counts. */
export async function importedModelsView() {
  const [models, nodes] = await Promise.all([listImportedModels(), routableNativeNodes().catch(() => [] as NativeNode[])]);
  const live = nodes.filter((n) => n.state === "ONLINE" || n.state === "BUSY");
  return {
    models: [...models]
      .sort((a, b) => b.lastRequestedAt - a.lastRequestedAt)
      .map((m) => {
        const serving = live.filter((n) => n.reported.capabilities.supportedModels.includes(m.id));
        return { ...publicImportedModel(m), nodesOnline: serving.length, nodesLoaded: serving.filter((n) => n.reported.capabilities.loadedModels.includes(m.id)).length, status: serving.length ? "available" : "waiting_for_node" };
      }),
    limit: MAX_IMPORTS(),
  };
}
