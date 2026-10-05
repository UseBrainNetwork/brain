import { UpstreamHttpError } from "@/providers/openaiCompatible";

/**
 * Public, non-leaking error code for a failed provider attempt. Vendor bodies and stack traces go
 * to the server log only; the customer sees "upstream 402", "timeout" or "unreachable".
 */
export function safeProviderError(e: unknown): string {
  if (e instanceof UpstreamHttpError) return `upstream ${e.status}`;
  const msg = e instanceof Error ? e.message : "";
  if (/^upstream \d{3}$/.test(msg)) return msg;
  if (e instanceof Error && e.name === "AbortError") return "timeout";
  return "unreachable";
}

export function logProviderError(providerId: string, e: unknown) {
  const detail = e instanceof UpstreamHttpError ? `${e.status} ${e.detail}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(`[provider:${providerId}] ${detail.slice(0, 500)}`);
}
