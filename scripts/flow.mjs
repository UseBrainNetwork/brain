// Dev utility: drives the contribute flow end to end in the system Chrome.
//   node scripts/flow.mjs [baseUrl] [--mobile]
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:3100";
const mobile = process.argv.includes("--mobile");
const noadapter = process.argv.includes("--noadapter");
const nogpu = process.argv.includes("--nogpu") || noadapter;
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--hide-scrollbars"],
});
fs.mkdirSync(".shots", { recursive: true });
const page = await browser.newPage();
// Chrome flags don't reliably disable WebGPU on macOS, so emulate the two failure modes in-page.
if (noadapter) await page.evaluateOnNewDocument(() => { if (navigator.gpu) navigator.gpu.requestAdapter = async () => null; });
else if (nogpu) await page.evaluateOnNewDocument(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));
await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } : { width: 1440, height: 960 });
page.on("pageerror", (e) => console.log("PAGEERROR", String(e)));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 300)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (text) => {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => b.textContent.trim().toLowerCase().startsWith(t.toLowerCase()));
    if (el) el.click();
    return Boolean(el);
  }, text);
  console.log(ok ? "clicked" : "NOT FOUND", text);
  return ok;
};
const tag = mobile ? "-m" : noadapter ? "-noadapter" : nogpu ? "-nogpu" : "";

await page.goto(`${base}/contribute`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await page.screenshot({ path: `.shots/flow1-detect${tag}.png` });
const gpu = await page.evaluate(async () => ({ hasGpu: Boolean(navigator.gpu), adapter: Boolean(await navigator.gpu?.requestAdapter()) }));
console.log("webgpu", gpu);
if (nogpu) {
  const t = await page.evaluate(() => document.body.innerText);
  console.log("bench button present:", /run benchmark/i.test(t), "| join button present:", /join network/i.test(t));
  console.log("fallback copy:", t.split("\n").filter((l) => /webgpu|unavailable|not available|unsupported/i.test(l)).slice(0, 6));
}
if (!nogpu) {
  await clickText("Run benchmark");
  await sleep(1200);
  await page.screenshot({ path: `.shots/flow2-bench${tag}.png` });
  await sleep(6000);
  await page.screenshot({ path: `.shots/flow3-result${tag}.png` });
  await clickText("Skip for now");
  await sleep(600);
  const before = await page.evaluate(() => document.body.innerText.match(/([\d,]+)\s*GPUs online/i)?.[1]);
  await clickText("Join network");
  await sleep(1500);
  const after = await page.evaluate(() => document.body.innerText.match(/([\d,]+)\s*GPUs online/i)?.[1]);
  console.log("counter", before, "→", after);
  await page.screenshot({ path: `.shots/flow4-joined${tag}.png` });
  await sleep(2600);
  await page.screenshot({ path: `.shots/flow5-job${tag}.png` });
  await sleep(9000);
  await page.screenshot({ path: `.shots/flow6-running${tag}.png` });
  const text = await page.evaluate(() => document.body.innerText);
  console.log("verified jobs in log:", (text.match(/\bverified\b/g) || []).length, "| rejected:", (text.match(/rejected/g) || []).length);
}
await browser.close();
