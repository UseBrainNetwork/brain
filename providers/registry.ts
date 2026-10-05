import "server-only";
import { BrowserNetworkProvider } from "./browserNetwork";
import { OpenAICompatibleProvider } from "./openaiCompatible";
import type { InferenceProvider } from "./types";

/** Provider order matters only as a tiebreak; the router ranks them. */
export function providers(): InferenceProvider[] {
  const env = process.env;
  return [
    new BrowserNetworkProvider(),
    new OpenAICompatibleProvider({
      id: "cloud-fallback",
      target: "CLOUD_FALLBACK",
      baseUrl: env.BRAIN_FALLBACK_BASE_URL,
      apiKey: env.BRAIN_FALLBACK_API_KEY,
      model: env.BRAIN_FALLBACK_MODEL,
      estLatencyMs: 900,
      costPer1M: null,
      reliability: 0.97,
    }),
    new OpenAICompatibleProvider({
      id: "external",
      target: "EXTERNAL_MODEL_PROVIDER",
      baseUrl: env.BRAIN_EXTERNAL_BASE_URL,
      apiKey: env.BRAIN_EXTERNAL_API_KEY,
      model: env.BRAIN_EXTERNAL_MODEL,
      estLatencyMs: 1200,
      costPer1M: null,
      reliability: 0.99,
    }),
  ];
}
