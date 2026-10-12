import { body, nodeRoute } from "@/api/http";
import { importModel, importView, type ImportError } from "@/services/modelImports";
import { json, rateLimit } from "@/services/security";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /v1/models/import — bring your own model.
 *
 *   { "source": "https://huggingface.co/ggml-org/gpt-oss-20b-GGUF", "file": "Q4_K_M" }
 *
 * `source` is a Hugging Face URL or org/repo; `file` (optional) names a GGUF file or quantisation.
 * The coordinator resolves the repository once and from then on routes `hf/<org>/<repo>` to nodes
 * that serve it. No account needed: importing is a request, not a purchase. Ten imports per hour
 * per address; the table has a ceiling (BRAIN_IMPORTS_MAX).
 */
const STATUS: Record<ImportError, number> = {
  invalid_source: 400,
  not_found: 404,
  gated: 403,
  not_text_generation: 422,
  no_chat_template: 422,
  no_gguf: 422,
  no_single_file_gguf: 422,
  unparsed_gguf: 422,
  too_large: 422,
  file_not_found: 422,
  limit_reached: 429,
  upstream_error: 502,
};

export const POST = nodeRoute(async (req, { ip }) => {
  if (!rateLimit(`import:${ip}`, 10, 3_600_000).ok) return json({ error: { code: "rate_limited", message: "Ten imports per hour per address." } }, 429);
  const raw = await body<{ source?: unknown; file?: unknown }>(req, 4 * 1024);
  const source = typeof raw.source === "string" ? raw.source : "";
  const file = typeof raw.file === "string" && raw.file.length <= 160 ? raw.file : undefined;
  const r = await importModel(source, ip, { file });
  if (!r.ok) return json({ error: { code: r.code, message: r.message, ...(r.suggestions?.length ? { suggestions: r.suggestions } : {}) } }, STATUS[r.code]);
  return json(await importView(r.model, r.created), r.created ? 201 : 200);
});
