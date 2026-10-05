// Dev utility: multi-tab demo test
//   node scripts/multitab.mjs [baseUrl] [--nodes=4] [--size=small|medium|large] [--kill]
// Multi-tab demo test: 1 /demo tab + N /node tabs (separate incognito contexts so each has its own identity).
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3100";
const N = Number(process.argv.find((a) => a.startsWith("--nodes="))?.split("=")[1] ?? 4);
const size = process.argv.find((a) => a.startsWith("--size="))?.split("=")[1] ?? "medium";
const kill = process.argv.includes("--kill");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = ".shots";
fs.mkdirSync(shots, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--hide-scrollbars"],
});
const wire = (p, tag) => {
  p.on("pageerror", (e) => console.log(tag, "PAGEERROR", String(e).slice(0, 200)));
  p.on("console", (m) => m.type() === "error" && console.log(tag, "CONSOLE", m.text().slice(0, 200)));
};

const demo = await browser.newPage();
wire(demo, "demo");
await demo.setViewport({ width: 1600, height: 1000 });
await demo.goto(`${base}/demo`, { waitUntil: "domcontentloaded" });
await sleep(1500);
await demo.screenshot({ path: `${shots}/demo-0.png` });

const nodes = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  wire(p, `node${i}`);
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`${base}/node`, { waitUntil: "domcontentloaded" });
  await sleep(600);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("JOIN NETWORK"))?.click());
  nodes.push({ ctx, p });
  await sleep(i === 0 ? 4500 : 2500);
  const txt = await demo.evaluate(() => document.body.innerText.match(/(\d+)\s+REAL NODES? ONLINE/i)?.[0]);
  console.log(`after node ${i}:`, txt);
}
await sleep(3000);
await demo.screenshot({ path: `${shots}/demo-joined.png` });
await nodes[0].p.screenshot({ path: `${shots}/node-waiting.png` });
const ids = await Promise.all(nodes.map((n) => n.p.evaluate(() => document.querySelector(".display")?.textContent)));
console.log("node ids", ids);

// Open controls, pick size, run.
await demo.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Demo controls")?.click());
await sleep(400);
await demo.evaluate((s) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === s)?.click(), size);
await sleep(200);
const t0 = Date.now();
const before = (await fetch(`${base}/api/jobs?limit=1`).then((r) => r.json())).jobs?.[0]?.id;
await demo.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("RUN TEST JOB"))?.click());
let killed = false;
let compShot = false;
let j;
for (let i = 0; i < 240; i++) {
  await sleep(250);
  j = (await fetch(`${base}/api/jobs?limit=1`).then((r) => r.json())).jobs?.[0];
  if (!j || j.id === before) continue;
  if (j.status === "computing" && !compShot) {
    compShot = true;
    await demo.screenshot({ path: `${shots}/demo-computing.png` });
    await nodes[0].p.screenshot({ path: `${shots}/node-computing.png` });
    if (kill) {
      console.log("closing node", ids[N - 1], "mid-job at", Date.now() - t0, "ms");
      await nodes[N - 1].ctx.close();
      killed = true;
    }
  }
  if (j.status === "completed" || j.status === "failed") {
    console.log("JOB", j.status.toUpperCase(), "in", Date.now() - t0, "ms");
    break;
  }
}
await sleep(800);
await demo.screenshot({ path: `${shots}/demo-complete.png` });
const panel = await demo.evaluate(() => document.body.innerText.split("\n").filter((l) => /Nodes used|Verified|Total compute|Latency|Work units|reassigned|JOB/.test(l)).slice(0, 14));
console.log(panel);
console.log("job", j?.id, j?.status, j?.totals, "attempts", j?.units?.length);
if (killed) {
  await sleep(14000); // sweepOffline window
  const txt = await demo.evaluate(() => document.body.innerText.match(/(\d+)\s+REAL NODES? ONLINE/i)?.[0]);
  console.log("after kill:", txt);
}
// Node verified screen
await nodes[0].p.screenshot({ path: `${shots}/node-after.png` });
console.log("node0 text:", (await nodes[0].p.evaluate(() => document.body.innerText)).replace(/\n+/g, " | ").slice(0, 300));
await browser.close();
