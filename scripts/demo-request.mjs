#!/usr/bin/env node
/**
 * Sends one request through the Brain API and shows what the network did with it:
 *   request → router → node → streamed answer → job timeline → signed receipt → accounting.
 *
 *   node scripts/demo-request.mjs [--url http://localhost:3000] [--model brain/mock] [--key brain_sk_...]
 *
 * Everything printed is read back from the coordinator after the fact; nothing is inferred.
 */
const args = Object.fromEntries(process.argv.slice(2).map((a, i, xs) => (a.startsWith("--") ? [a.slice(2), xs[i + 1] ?? ""] : [])).filter((x) => x.length));
const url = (args.url || process.env.BRAIN_URL || "http://localhost:3000").replace(/\/+$/, "");
const model = args.model || "brain/mock";
const key = args.key || process.env.BRAIN_API_KEY;
const headers = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };

const line = (k, v) => console.log(`${k.padEnd(14)} ${v}`);

const models = await fetch(`${url}/v1/models`).then((r) => r.json());
const m = models.data.find((x) => x.id === model);
if (!m) throw new Error(`model ${model} is not listed by ${url}/v1/models`);
line("model", `${model} · ${m.status}${m.nodes_online != null ? ` · ${m.nodes_online} node(s) online` : ""}`);
if (m.nodes_online === 0) {
  console.log("\nNo Brain Node serves this model right now. Start one:  BRAIN_NODE_MODE=mock BRAIN_COORDINATOR_URL=" + url + " npm run node");
  process.exit(2);
}

const t0 = Date.now();
const res = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model, stream: true, max_tokens: 48, messages: [{ role: "user", content: "Describe what you are in one sentence." }] }) });
line("request id", res.headers.get("brain-request-id") ?? "—");
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
process.stdout.write("answer".padEnd(15));
let brain = null;
let buf = "";
const dec = new TextDecoder();
let firstByte = null;
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const ev = /^event: (\w+)/m.exec(p)?.[1];
    const data = p
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    const j = JSON.parse(data);
    if (ev === "brain") brain = j;
    else if (!ev) {
      const d = j.choices?.[0]?.delta?.content;
      if (d) {
        if (firstByte == null) firstByte = Date.now() - t0;
        process.stdout.write(d);
      }
    }
  }
}
console.log();
line("first token", firstByte == null ? "—" : `${firstByte} ms`);
if (!brain) {
  console.log("no run summary received");
  process.exit(1);
}
line("routed to", `${brain.target} · ${brain.provider} · ${brain.nodesUsed} node(s)`);
line("verification", `${brain.verification} (server-verified: ${brain.verified ? "yes" : "no"})`);
line("cost", brain.cost ? `$${brain.cost.amount.toFixed(8)} (${brain.cost.basis})` : "UNKNOWN (no list price configured)");

const jobId = brain.receiptId?.replace(/^r-/, "");
if (jobId) {
  const job = await fetch(`${url}/api/coordinator/jobs/${jobId}`).then((r) => r.json());
  console.log("\njob timeline   (coordinator clock, ms from creation)");
  for (const h of job.history) console.log(`  ${String(h.at - job.createdAt).padStart(6)} ms  ${h.state.padEnd(10)} ${h.note ?? ""}`);
  line("\nrouting", job.routing?.reason ?? "—");
  const { receipt } = await fetch(`${url}/api/receipts/${brain.receiptId}`).then((r) => r.json());
  console.log("\nreceipt", brain.receiptId);
  line("  node", receipt.nodesUsed.join(", "));
  line("  tokens", `${receipt.tokens.prompt} in / ${receipt.tokens.completion} out (${receipt.tokens.basis})`);
  line("  hash", receipt.canonical?.hash ?? receipt.resultHash);
  line("  signature", receipt.attestation.kind === "signature" ? `ed25519 by ${receipt.attestation.signer.slice(0, 12)}…` : receipt.attestation.kind);
  const nodes = await fetch(`${url}/api/coordinator/nodes`).then((r) => r.json());
  const n = nodes.nodes.find((x) => x.nodeId === receipt.nodesUsed[0]);
  if (n) line("  node stats", `${n.measured.jobsCompleted} completed · ${n.measured.tokensGenerated} tokens · reliability ${n.reputation}/100`);
  console.log(`\nopen ${url}/network and ${url}/receipt/${brain.receiptId}`);
}
