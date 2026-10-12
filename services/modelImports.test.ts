import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { filterAllowed, isAllowedModel, matchServedModel, modelSpec, setImportedModels } from "@/node/models";
import type { NativeNode } from "@/services/coordinator/registry";
import { chooseFile, formatParams, importOffersFor, minVramMbFor, parseSource, quantOf, resolveRepo, specOf, type ImportedModel } from "./modelImports";

const hf = (over: Record<string, unknown> = {}) => ({
  id: "ggml-org/gpt-oss-20b-GGUF",
  private: false,
  gated: false,
  pipeline_tag: "text-generation",
  tags: ["gguf", "license:apache-2.0", "conversational"],
  gguf: { total: 20_914_757_184, architecture: "gpt-oss", context_length: 131_072, chat_template: "{{ messages }}" },
  siblings: [{ rfilename: "README.md", size: 100 }, { rfilename: "eagle3-gpt-oss-20b-Q8_0.gguf", size: 1e9 }, { rfilename: "gpt-oss-20b-MXFP4.gguf", size: 12_109_566_624 }],
  ...over,
});

const fetchFor = (routes: Record<string, { status?: number; body: unknown }>): typeof fetch =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  }) as unknown as typeof fetch;

describe("parseSource", () => {
  it("accepts URLs, hf.co, hf: and plain org/repo; rejects the rest", () => {
    expect(parseSource("https://huggingface.co/openai/gpt-oss-20b")).toBe("openai/gpt-oss-20b");
    expect(parseSource("https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/tree/main?x=1")).toBe("ggml-org/gpt-oss-20b-GGUF");
    expect(parseSource("hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF")).toBe("bartowski/Qwen2.5-7B-Instruct-GGUF");
    expect(parseSource("hf:org/repo")).toBe("org/repo");
    expect(parseSource("hf/org/repo")).toBe("org/repo");
    expect(parseSource("org/repo")).toBe("org/repo");
    expect(parseSource("repo")).toBeNull();
    expect(parseSource("org/re po")).toBeNull();
    expect(parseSource("https://example.com/org/repo")).toBeNull();
    expect(parseSource("")).toBeNull();
  });
});

describe("file choice", () => {
  it("reads the quantisation label off the file name", () => {
    expect(quantOf("Qwen2.5-7B-Instruct-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("gpt-oss-20b-MXFP4.gguf")).toBe("MXFP4");
    expect(quantOf("model.Q8_0.gguf")).toBe("Q8_0");
    expect(quantOf("Qwen2.5-7B-Instruct-IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantOf("llama-f16.gguf")).toBe("F16");
  });
  it("prefers Q4_K_M, then the preference order, skipping projectors, drafts and split files", () => {
    const files = [
      { name: "mmproj-F16.gguf", size: 1 },
      { name: "m-Q8_0.gguf", size: 8 },
      { name: "m-Q4_K_M.gguf", size: 4 },
      { name: "m-00001-of-00002.gguf", size: 9 },
    ];
    expect(chooseFile(files)?.name).toBe("m-Q4_K_M.gguf");
    expect(chooseFile(files, "q8_0")?.name).toBe("m-Q8_0.gguf");
    expect(chooseFile(files, "m-Q8_0.gguf")?.name).toBe("m-Q8_0.gguf");
    expect(chooseFile(files, "Q2_K")).toBeNull();
    expect(chooseFile([{ name: "a-Q2_K.gguf", size: 1 }, { name: "a-Q3_K_L.gguf", size: 3 }, { name: "a-Q5_K_L.gguf", size: 5 }])?.name).toBe("a-Q3_K_L.gguf");
    expect(chooseFile([{ name: "mmproj.gguf", size: 1 }])).toBeNull();
  });
  it("sizes memory from the file and formats parameter counts from the header", () => {
    expect(minVramMbFor(12_109_566_624)).toBe(Math.ceil((12_109_566_624 / 1_048_576) * 1.1) + 1_536);
    expect(formatParams(20_914_757_184)).toBe("20.9B");
    expect(formatParams(1_540_000_000)).toBe("1.5B");
    expect(formatParams(0)).toBe("0");
  });
});

describe("resolveRepo", () => {
  it("resolves a GGUF repository to one file", async () => {
    const r = await resolveRepo("ggml-org/gpt-oss-20b-GGUF", undefined, fetchFor({ "/api/models/ggml-org/gpt-oss-20b-GGUF": { body: hf() } }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file.name).toBe("gpt-oss-20b-MXFP4.gguf");
      expect(r.hf.gguf?.total).toBe(20_914_757_184);
    }
  });
  it("points at quantisations when the repository has no GGUF", async () => {
    const r = await resolveRepo("openai/gpt-oss-20b", undefined, fetchFor({
      "/api/models/openai/gpt-oss-20b?": { body: hf({ id: "openai/gpt-oss-20b", gguf: undefined, siblings: [{ rfilename: "model-00001-of-00002.safetensors", size: 1 }] }) },
      "/api/models?filter=gguf": { body: [{ id: "unsloth/gpt-oss-20b-GGUF", downloads: 493_012 }, { id: "ggml-org/gpt-oss-20b-GGUF", downloads: 165_903 }] },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("no_gguf");
      expect(r.suggestions?.map((s) => s.repo)).toEqual(["unsloth/gpt-oss-20b-GGUF", "ggml-org/gpt-oss-20b-GGUF"]);
      expect(r.message).toContain("unsloth/gpt-oss-20b-GGUF");
    }
  });
  it("refuses image models, gated repos, base models without a chat template, unknown repos", async () => {
    const img = await resolveRepo("a/img", undefined, fetchFor({ "/api/models/a/img": { body: hf({ id: "a/img", pipeline_tag: "text-to-image" }) } }));
    expect(!img.ok && img.code).toBe("not_text_generation");
    const gated = await resolveRepo("a/g", undefined, fetchFor({ "/api/models/a/g": { body: hf({ id: "a/g", gated: "manual" }) } }));
    expect(!gated.ok && gated.code).toBe("gated");
    const base = await resolveRepo("a/b", undefined, fetchFor({ "/api/models/a/b": { body: hf({ id: "a/b", tags: ["gguf"], gguf: { total: 1e9 } }) } }));
    expect(!base.ok && base.code).toBe("no_chat_template");
    const missing = await resolveRepo("a/none", undefined, fetchFor({}));
    expect(!missing.ok && missing.code).toBe("not_found");
    const big = await resolveRepo("a/big", undefined, fetchFor({ "/api/models/a/big": { body: hf({ id: "a/big", siblings: [{ rfilename: "x-Q4_K_M.gguf", size: 90e9 }] }) } }));
    expect(!big.ok && big.code).toBe("too_large");
  });
});

const imported: ImportedModel = {
  id: "hf/ggml-org/gpt-oss-20b-gguf",
  repo: "ggml-org/gpt-oss-20b-GGUF",
  file: { repo: "ggml-org/gpt-oss-20b-GGUF", file: "gpt-oss-20b-MXFP4.gguf", quant: "MXFP4", sizeBytes: 12_109_566_624, architecture: "gpt-oss" },
  params: "20.9B",
  context: 32_768,
  license: "apache-2.0",
  minVramMb: minVramMbFor(12_109_566_624),
  createdAt: 1,
  lastRequestedAt: 2,
  requests: 1,
  requestedBy: "ip",
};
const small: ImportedModel = { ...imported, id: "hf/bartowski/qwen2.5-7b-instruct-gguf", repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: { repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", quant: "Q4_K_M", sizeBytes: 4_683_074_240, architecture: "qwen2" }, params: "7.6B", minVramMb: minVramMbFor(4_683_074_240), lastRequestedAt: 5 };

describe("node/models with imports", () => {
  beforeEach(() => setImportedModels([specOf(imported), specOf(small)]));
  it("treats imported ids as routable models and keeps the allowlist first", () => {
    expect(isAllowedModel("hf/ggml-org/gpt-oss-20b-gguf")).toBe(true);
    expect(isAllowedModel("hf/nobody/nothing")).toBe(false);
    expect(modelSpec("hf/ggml-org/gpt-oss-20b-gguf")?.params).toBe("20.9B");
    expect(filterAllowed(["hf/ggml-org/gpt-oss-20b-gguf", "qwen/qwen2.5-7b-instruct", "hf/x/y", "hf/ggml-org/gpt-oss-20b-gguf"])).toEqual(["qwen/qwen2.5-7b-instruct", "hf/ggml-org/gpt-oss-20b-gguf"]);
  });
  it("maps the names Ollama and llama.cpp use for an imported GGUF onto its id, and nothing shorter", () => {
    expect(matchServedModel("hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4")?.id).toBe("hf/ggml-org/gpt-oss-20b-gguf");
    expect(matchServedModel("hf.co/ggml-org/gpt-oss-20b-GGUF")?.id).toBe("hf/ggml-org/gpt-oss-20b-gguf");
    expect(matchServedModel("gpt-oss-20b-MXFP4.gguf")?.id).toBe("hf/ggml-org/gpt-oss-20b-gguf");
    expect(matchServedModel("gpt-oss-20b-MXFP4")?.id).toBe("hf/ggml-org/gpt-oss-20b-gguf");
    // The bartowski Qwen GGUF is an allowlisted model's quantisation too; the imported id wins only on its own names.
    expect(matchServedModel("hf.co/bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M")?.id).toBe("hf/bartowski/qwen2.5-7b-instruct-gguf");
    expect(matchServedModel("qwen2.5:7b-instruct")?.id).toBe("qwen/qwen2.5-7b-instruct");
    expect(matchServedModel("gpt-oss:20b")).toBeUndefined();
  });
  it("forgets imports when the table is replaced", () => {
    setImportedModels([]);
    expect(isAllowedModel("hf/ggml-org/gpt-oss-20b-gguf")).toBe(false);
  });
});

const node = (over: Partial<{ vram: number | null; ram: number; disk: number | null; budget: number | null; have: string[]; mock: boolean }> = {}): NativeNode =>
  ({
    nodeId: "N-00000001",
    reported: {
      hardware: { gpus: over.vram === null ? [] : [{ vramTotalMb: over.vram ?? 24_000 }], ramTotalMb: over.ram ?? 32_000, diskFreeGb: over.disk === undefined ? 200 : over.disk, mock: over.mock ?? false },
      capabilities: { supportedModels: over.have ?? [], imports: over.budget === null ? null : { diskBudgetGb: over.budget ?? 50 } },
    },
  }) as unknown as NativeNode;

describe("importOffersFor", () => {
  const table = [imported, small];
  it("offers the most recently requested models that fit memory and disk, skipping what the node serves", () => {
    expect(importOffersFor(node(), table).map((o) => o.model)).toEqual(["hf/bartowski/qwen2.5-7b-instruct-gguf", "hf/ggml-org/gpt-oss-20b-gguf"]);
    expect(importOffersFor(node({ have: ["hf/bartowski/qwen2.5-7b-instruct-gguf"] }), table).map((o) => o.model)).toEqual(["hf/ggml-org/gpt-oss-20b-gguf"]);
    expect(importOffersFor(node({ vram: 8_000 }), table).map((o) => o.model)).toEqual(["hf/bartowski/qwen2.5-7b-instruct-gguf"]);
    expect(importOffersFor(node({ budget: 10 }), table).map((o) => o.model)).toEqual(["hf/bartowski/qwen2.5-7b-instruct-gguf"]);
    expect(importOffersFor(node({ disk: 6 }), table).map((o) => o.model)).toEqual([]);
  });
  it("offers nothing to nodes that did not opt in, mock nodes, or nodes with no memory figure; sizes against RAM when there is no GPU figure", () => {
    expect(importOffersFor(node({ budget: null }), table)).toEqual([]);
    expect(importOffersFor(node({ mock: true }), table)).toEqual([]);
    expect(importOffersFor(node({ vram: null, ram: 0 }), table)).toEqual([]);
    expect(importOffersFor(node({ vram: null, ram: 12_000 }), table).map((o) => o.model)).toEqual(["hf/bartowski/qwen2.5-7b-instruct-gguf"]);
    expect(importOffersFor(node(), table)[0]).toMatchObject({ repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", quant: "Q4_K_M" });
  });
});
