#!/usr/bin/env node
// brain — command line for the BRAIN gateway. Zero dependencies, Node 18+.
//
//   BRAIN_API_KEY=brain_sk_… brain chat "Summarize this file" < notes.txt
//   brain chat --model brain/code --json "Return {ok:true}"
//   brain models
//   brain receipt r-ij-…            # fetch + verify the signature locally against the public key
//   brain receipts --days 30 --csv > october.csv
//   brain quote "Hello"             # the pay-per-call 402 quote for this request, no key needed
//   brain stats
//
// Set BRAIN_HOST to point at another gateway (default https://brainnetwork.app).

import { createPublicKey, verify as edVerify, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const HOST = (process.env.BRAIN_HOST ?? "https://brainnetwork.app").replace(/\/$/, "");
const KEY = process.env.BRAIN_API_KEY;
const argv = process.argv.slice(2);
const cmd = argv.shift();

const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) (flags[k] = next), i++;
    else flags[k] = true;
  } else positional.push(a);
}

// Same canonical form the coordinator signs: sorted keys, no undefined, no whitespace.
const canonicalJson = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]` : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`);

const die = (msg, code = 1) => (process.stderr.write(`brain: ${msg}\n`), process.exit(code));
const auth = () => (KEY ? { authorization: `Bearer ${KEY}` } : die("set BRAIN_API_KEY (Account → API keys at " + HOST + "/account)"));
const stdin = () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
const api = async (path, init = {}) => {
  const r = await fetch(HOST + path, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { r, body };
};
const fail = ({ r, body }) => die(`${r.status} ${body?.error?.code ?? body?.error ?? ""} ${body?.error?.message ?? ""}`.trim());

function chatBody() {
  const prompt = [positional.join(" "), stdin()].filter(Boolean).join("\n\n");
  if (!prompt) die("give a prompt as an argument or on stdin");
  const body = { model: flags.model ?? "brain/auto", messages: [], stream: !flags["no-stream"] };
  if (flags.system) body.messages.push({ role: "system", content: flags.system });
  body.messages.push({ role: "user", content: prompt });
  if (flags.json) body.response_format = { type: "json_object" };
  if (flags["max-tokens"]) body.max_tokens = Number(flags["max-tokens"]);
  for (const k of ["mode", "privacy", "node"]) if (flags[k]) body[k] = flags[k];
  if (flags.retries !== undefined) body.retries = Number(flags.retries);
  if (flags.fallback !== undefined) body.fallback = flags.fallback !== "false";
  if (flags.timeout) body.timeout_ms = Number(flags.timeout);
  return body;
}

async function chat() {
  const body = chatBody();
  const r = await fetch(HOST + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(body) });
  if (!r.ok) return fail({ r, body: await r.json().catch(() => ({})) });
  if (!body.stream) {
    const j = await r.json();
    process.stdout.write((j.choices?.[0]?.message?.content ?? "") + "\n");
    return summary(j.brain);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let brain = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\S+)/m.exec(frame)?.[1] ?? "message";
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (ev === "brain") brain = j;
      else if (ev === "error") (brain = j.brain), process.stderr.write(`\nbrain: ${j.error?.code} ${j.error?.message}\n`);
      else if (ev === "attached") brain && (brain.attached = j);
      else process.stdout.write(j.choices?.[0]?.delta?.content ?? "");
    }
  }
  process.stdout.write("\n");
  summary(brain);
}

function summary(b) {
  if (!b || flags.quiet) return;
  const cost = b.cost?.amount != null ? `$${Number(b.cost.amount).toFixed(6)} (${b.cost.basis})` : "unknown";
  const parts = [`route ${b.target ?? "?"}`, `model ${b.model ?? "?"}`, `${b.latencyMs ?? "?"} ms`, `cost ${cost}`, b.verified ? "verified" : `unverified (${b.verification ?? "?"})`];
  if (b.receiptId) parts.push(`receipt ${HOST}/receipt/${b.receiptId}`);
  process.stderr.write("· " + parts.join(" · ") + "\n");
}

async function models() {
  const res = await api("/v1/models");
  if (!res.r.ok) return fail(res);
  for (const m of res.body.data ?? []) process.stdout.write(`${m.id}\n`);
}

async function stats() {
  const res = await api("/api/stats");
  if (!res.r.ok) return fail(res);
  process.stdout.write(JSON.stringify(res.body, null, 2) + "\n");
}

async function receipt() {
  const id = positional[0] ?? die("brain receipt <id>");
  const res = await api(`/api/receipts/${encodeURIComponent(id)}/verify`);
  if (!res.r.ok) return fail(res);
  const v = res.body;
  // Independent check: recompute the canonical hash and verify the ed25519 signature ourselves.
  let local = "no signature to check";
  if (v.attestation?.kind === "signature" && v.canonical) {
    const recomputed = createHash("sha256").update(canonicalJson(v.canonical.body)).digest("hex");
    const hashOk = recomputed === v.canonical.storedHash;
    const signer = v.attestation.signer ?? v.coordinatorPublicKey;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signer, "base64")]), format: "der", type: "spki" });
    const sigOk = edVerify(null, Buffer.from(recomputed, "hex"), key, Buffer.from(v.attestation.signature, "base64"));
    const current = signer === v.coordinatorPublicKey ? "current coordinator key" : "an earlier coordinator key";
    local = hashOk && sigOk ? `hash and signature verified locally against ${current}` : `LOCAL CHECK FAILED (hash ${hashOk ? "ok" : "mismatch"}, signature ${sigOk ? "ok" : "invalid"})`;
  }
  process.stdout.write(JSON.stringify({ ...v, localCheck: local }, null, 2) + "\n");
  if (local.startsWith("LOCAL CHECK FAILED")) process.exit(2);
}

async function receipts() {
  const days = Number(flags.days ?? 31);
  const to = Date.now();
  const from = to - days * 86_400_000;
  const q = new URLSearchParams({ from: String(from), to: String(to), limit: String(flags.limit ?? 1000) });
  if (flags.csv) q.set("format", "csv");
  if (flags.verify) q.set("verify", "1");
  const r = await fetch(`${HOST}/v1/receipts?${q}`, { headers: auth() });
  if (!r.ok) return fail({ r, body: await r.json().catch(() => ({})) });
  process.stdout.write(await r.text());
  if (!flags.csv) process.stdout.write("\n");
}

async function quote() {
  const body = chatBody();
  body.stream = false;
  const res = await api("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", "x-brain-pay": flags.currency ?? "sol" }, body: JSON.stringify(body) });
  if (res.r.status !== 402) return fail(res);
  process.stdout.write(JSON.stringify(res.body.payment, null, 2) + "\n");
}

const HELP = `brain <command> [options]

  chat <prompt>        stream a completion (prompt also read from stdin)
                       --model brain/auto --system "…" --json --max-tokens N
                       --mode auto|cheap|fast|quality --privacy standard|private --node N-XXXXXXXX
                       --retries 0..2 --fallback true|false --timeout ms --no-stream --quiet
  models               list model ids
  receipt <id>         fetch a receipt and verify its signature locally
  receipts             export your requests (--days 31 --limit 1000 --csv --verify)
  quote <prompt>       pay-per-call quote for this request (--currency sol|usdc), no key needed
  stats                network stats

env: BRAIN_API_KEY, BRAIN_HOST (default https://brainnetwork.app)
`;

const run = { chat, models, receipt, receipts, quote, stats }[cmd];
if (!run || flags.help) (process.stdout.write(HELP), process.exit(run ? 0 : cmd ? 1 : 0));
else run().catch((e) => die(e?.message ?? String(e)));
