import { hubUrl, type NetworkModel, type StageSpan } from "./config";
import { GGUF_EMBED, GGUF_FINAL_NORM, GGUF_OUTPUT, fetchGgufEntries, fetchGgufHeader, ggufLayerNames, type GgufHeader, type LoadedEntries } from "./gguf";

/**
 * Browser-side weight loading for one pipeline stage: GGUF header once, then one range request per
 * tensor of the stage, cached in the Cache API so a returning node does not download again.
 */

const CACHE = "brain-weights-v2";

async function cachingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const range = (init?.headers as Record<string, string> | undefined)?.range;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!range || typeof caches === "undefined") return fetch(input, init);
  // Fragments are dropped from Request URLs, so the range goes in the query string of the cache key.
  const key = new Request(`${url}${url.includes("?") ? "&" : "?"}brain_range=${encodeURIComponent(range)}`);
  const cache = await caches.open(CACHE).catch(() => null);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return new Response(await hit.arrayBuffer(), { status: 206, headers: { "content-range": range } });
  }
  const res = await fetch(input, init);
  if (res.status === 206 && cache) {
    const buf = await res.clone().arrayBuffer();
    await cache.put(key, new Response(buf)).catch(() => {});
  }
  return res;
}

const headers = new Map<string, Promise<GgufHeader>>();

/** Tensor names a stage needs, in download order. Optional names (q/k norm, untied head) are filtered by the loader. */
export function stageTensorNames(span: StageSpan): { names: string[]; optional: Set<string> } {
  const names: string[] = [];
  const optional = new Set<string>();
  if (span.hasEmbed || span.hasHead) names.push(GGUF_EMBED);
  for (let l = span.layerFrom; l < span.layerTo; l++) {
    const n = ggufLayerNames(l);
    names.push(n.ln1, n.wq, n.wk, n.wv, n.wo, n.qNorm, n.kNorm, n.ln2, n.wgate, n.wup, n.wdown);
    optional.add(n.qNorm);
    optional.add(n.kNorm);
  }
  if (span.hasHead) {
    names.push(GGUF_FINAL_NORM, GGUF_OUTPUT);
    optional.add(GGUF_OUTPUT);
  }
  return { names, optional };
}

export async function stageHeader(model: NetworkModel): Promise<GgufHeader> {
  const url = hubUrl(model, model.weightsFile);
  let header = headers.get(url);
  if (!header) {
    header = fetchGgufHeader(url, cachingFetch);
    headers.set(url, header);
    header.catch(() => headers.delete(url));
  }
  return header;
}

export async function loadStageEntries(
  model: NetworkModel,
  span: StageSpan,
  onProgress?: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<LoadedEntries> {
  const url = hubUrl(model, model.weightsFile);
  const h = await stageHeader(model);
  const { names, optional } = stageTensorNames(span);
  return fetchGgufEntries(url, h, names, { fetchImpl: cachingFetch, onProgress, signal, optional });
}
