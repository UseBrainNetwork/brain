import { hubUrl, type NetworkModel, type StageSpan } from "./config";
import { fetchHeader, fetchTensors, layerTensorNames, type LoadedTensors, type SafetensorsHeader } from "./safetensors";

/**
 * Browser-side weight loading for one pipeline stage: header once, then range requests for the
 * stage's layers only, cached in the Cache API so a returning node does not download again.
 */

const CACHE = "brain-weights-v1";

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

const headers = new Map<string, Promise<SafetensorsHeader>>();

export function stageTensorNames(span: StageSpan): string[] {
  const names: string[] = [];
  for (let l = span.layerFrom; l < span.layerTo; l++) names.push(...layerTensorNames(l));
  return names;
}

export async function loadStageTensors(
  model: NetworkModel,
  span: StageSpan,
  onProgress?: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<LoadedTensors> {
  const url = hubUrl(model, model.weightsFile);
  let header = headers.get(url);
  if (!header) {
    header = fetchHeader(url, cachingFetch);
    headers.set(url, header);
    header.catch(() => headers.delete(url));
  }
  const h = await header;
  return fetchTensors(url, h, stageTensorNames(span), { fetchImpl: cachingFetch, onProgress, signal });
}

/** Approximate download size of a stage in bytes (bf16 checkpoint). */
export function stageDownloadBytes(model: NetworkModel, span: StageSpan): number {
  const c = model.config;
  const headDim = c.hidden / c.heads;
  const perLayer = 2 * c.hidden * c.hidden + 2 * c.hidden * c.kvHeads * headDim + 3 * c.hidden * c.intermediate + 2 * c.hidden;
  return perLayer * 2 * (span.layerTo - span.layerFrom);
}
