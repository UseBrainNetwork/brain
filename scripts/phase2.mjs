// Dev utility: Phase 2 end-to-end check
//   node scripts/phase2.mjs [baseUrl] [--nodes=3]
// Joins N real browser nodes, places a compute order through /auto, then screenshots
// the receipt, node profile, /network, /economics and /capacity pages.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3100";
const N = Number(process.argv.find((a) => a.startsWith("--nodes="))?.split("=")[1] ?? 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = ".shots";
fs.mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--hide-scrollbars"],
});
const wire = (p, tag) => {
  p.on("pageerror", (e) => console.log(tag, "PAGEERROR", String(e).slice(0, 300)));
  p.on("console", (m) => m.type() === "error" && console.log(tag, "CONSOLE", m.text().slice(0, 300)));
};
const click = (p, text) => p.evaluate((t) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes(t))?.click(), text);

// Join nodes (separate contexts = separate identities).
const nodes = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  wire(p, `node${i}`);
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${base}/node`, { waitUntil: "domcontentloaded" });
  await sleep(600);
  await click(p, "JOIN NETWORK");
  nodes.push({ ctx, p });
  await sleep(i === 0 ? 4500 : 2000);
}
const ids = await Promise.all(nodes.map((n) => n.p.evaluate(() => document.querySelector(".display")?.textContent)));
console.log("nodes", ids);

// /auto compute order
const auto = await browser.newPage();
wire(auto, "auto");
await auto.setViewport({ width: 1500, height: 1000 });
await auto.goto(`${base}/auto`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await auto.screenshot({ path: `${shots}/auto-0.png` });
await click(auto, "medium");
await sleep(200);
const t0 = Date.now();
await click(auto, "Route & execute");
let receiptId = null;
for (let i = 0; i < 200; i++) {
  await sleep(300);
  if (i === 6) await auto.screenshot({ path: `${shots}/auto-estimating.png` });
  receiptId = await auto.evaluate(() => [...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).find((h) => h?.startsWith("/receipt/"))?.slice("/receipt/".length) ?? null);
  const txt = await auto.evaluate(() => document.body.innerText);
  if (/FAILED|REJECTED/.test(txt) && !receiptId) {
    console.log("order failed:", txt.match(/.*(FAILED|REJECTED).*/)?.[0]);
    break;
  }
  if (receiptId) break;
}
console.log("order done in", Date.now() - t0, "ms, receipt", receiptId);
await sleep(800);
await auto.screenshot({ path: `${shots}/auto-done.png`, fullPage: true });

const shoot = async (path, name, h = 1000, full = true) => {
  const p = await browser.newPage();
  wire(p, name);
  await p.setViewport({ width: 1500, height: h });
  await p.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await p.screenshot({ path: `${shots}/${name}.png`, fullPage: full });
  const text = await p.evaluate(() => document.body.innerText);
  await p.close();
  return text;
};
if (receiptId) {
  const t = await shoot(`/receipt/${receiptId}`, "receipt");
  console.log("receipt page:", t.split("\n").slice(0, 12).join(" | "));
}
const prof = await shoot(`/node/${ids[0]}`, "node-profile");
console.log("node profile:", prof.split("\n").slice(0, 10).join(" | "));
const net = await shoot("/network", "network");
console.log("network:", net.split("\n").slice(0, 16).join(" | "));
const eco = await shoot("/economics", "economics");
console.log("economics:", eco.split("\n").slice(0, 20).join(" | "));
await shoot("/capacity", "capacity");
await shoot("/explorer/job/" + (receiptId ?? "r-5000001").slice(2), "explorer-real-job", 1000, false);

const api = await fetch(`${base}/api/economics`).then((r) => r.json());
console.log("economics api: events", api.snapshot?.events, "receipts", api.receipts?.length, "paid", JSON.stringify(api.snapshot?.customersPaid));
await browser.close();
