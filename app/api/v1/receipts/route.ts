import { nodeRoute } from "@/api/http";
import type { ComputeReceipt, CustomerRequestRecord } from "@/domain/economy";
import { authenticate } from "@/services/customers";
import { verifyReceipt } from "@/services/coordinator/receipts";
import { getReceipt } from "@/services/receipts";
import { bearer, json } from "@/services/security";
import { getStore } from "@/services/store";

export const dynamic = "force-dynamic";

/**
 * GET /v1/receipts — the caller's requests with their compute receipts, for audit.
 *
 *   ?from=<ms|ISO>&to=<ms|ISO>   window (default: last 31 days)
 *   ?limit=<n>                   up to 1000 rows (default 500)
 *   ?format=json|csv             csv is one row per request, receipt fields flattened
 *   ?verify=1                    recompute each signed receipt's hash and check its signature
 *
 * Every row is one of the caller's own requests; money fields are null where no price applied, never
 * zero in their place. Receipts that were signed by the coordinator carry `attestation.kind =
 * "signature"`; with verify=1 the row says whether the signature still checks out today.
 */

type Row = {
  requestId: string;
  at: number;
  model: string;
  endpoint: CustomerRequestRecord["endpoint"];
  ok: boolean;
  routeTarget: string | null;
  providerId: string | null;
  nodesUsed: string[];
  inputUnits: number;
  outputUnits: number;
  costUsd: number | null;
  latencyMs: number;
  receiptId: string | null;
  receipt: Pick<ComputeReceipt, "status" | "verificationMethod" | "verificationConfidence" | "resultHash" | "attestation" | "customerCost" | "source"> | null;
  verified: { ok: boolean; reason?: string } | null;
};

const parseTime = (s: string | null, fallback: number) => {
  if (!s) return fallback;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : fallback;
};

const csvCell = (v: unknown) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join(" ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const GET = nodeRoute(async (req) => {
  const auth = await authenticate(bearer(req));
  if (!auth) return json({ error: { code: "invalid_api_key", message: "Invalid or missing API key." } }, 401);
  const q = new URL(req.url).searchParams;
  const now = Date.now();
  const to = parseTime(q.get("to"), now);
  const from = parseTime(q.get("from"), to - 31 * 86_400_000);
  const limit = Math.min(1000, Math.max(1, Number(q.get("limit")) || 500));
  const verify = q.get("verify") === "1" || q.get("verify") === "true";
  const format = q.get("format") === "csv" ? "csv" : "json";

  const records = await getStore().listDocs<CustomerRequestRecord>("request", { key: auth.customer.customerId, from, to, limit });
  const receipts = await Promise.all(records.map((r) => (r.receiptId ? getReceipt(r.receiptId) : Promise.resolve(null))));
  const rows: Row[] = records.map((r, i) => {
    const rc = receipts[i];
    return {
      requestId: r.id,
      at: r.at,
      model: r.model,
      endpoint: r.endpoint,
      ok: r.ok,
      routeTarget: r.route?.target ?? null,
      providerId: r.route?.providerId ?? null,
      nodesUsed: r.nodesUsed,
      inputUnits: r.inputUnits,
      outputUnits: r.outputUnits,
      costUsd: r.cost,
      latencyMs: r.latencyMs,
      receiptId: r.receiptId,
      receipt: rc ? { status: rc.status, verificationMethod: rc.verificationMethod, verificationConfidence: rc.verificationConfidence, resultHash: rc.resultHash, attestation: rc.attestation, customerCost: rc.customerCost, source: rc.source } : null,
      verified: verify && rc ? (rc.attestation.kind === "signature" ? verifyReceipt(rc) : { ok: false, reason: "unsigned" }) : null,
    };
  });
  const priced = rows.filter((r) => r.costUsd != null);
  const summary = { requests: rows.length, ok: rows.filter((r) => r.ok).length, withReceipt: rows.filter((r) => r.receiptId).length, signed: rows.filter((r) => r.receipt?.attestation.kind === "signature").length, costUsd: priced.length ? priced.reduce((s, r) => s + (r.costUsd ?? 0), 0) : null };

  if (format === "csv") {
    const cols = ["requestId", "at", "atIso", "model", "endpoint", "ok", "routeTarget", "providerId", "nodesUsed", "inputUnits", "outputUnits", "costUsd", "latencyMs", "receiptId", "receiptStatus", "verificationMethod", "verificationConfidence", "resultHash", "attestation", "signatureValid"];
    const lines = [cols.join(",")];
    for (const r of rows) {
      lines.push(
        [r.requestId, r.at, new Date(r.at).toISOString(), r.model, r.endpoint, r.ok, r.routeTarget, r.providerId, r.nodesUsed, r.inputUnits, r.outputUnits, r.costUsd, r.latencyMs, r.receiptId, r.receipt?.status ?? null, r.receipt?.verificationMethod ?? null, r.receipt?.verificationConfidence ?? null, r.receipt?.resultHash ?? null, r.receipt?.attestation.kind ?? null, r.verified ? r.verified.ok : null]
          .map(csvCell)
          .join(","),
      );
    }
    const name = `brain-receipts-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}.csv`;
    return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
  }
  return json({ customer: { id: auth.customer.customerId, label: auth.customer.label }, from, to, summary, rows });
}, 60);
