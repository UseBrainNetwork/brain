// Dev utility: proves a contributor survives the server forgetting its session.
//   node scripts/recovery.mjs [baseUrl]   then restart the server when it prints RESTART_NOW.
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3200";
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 960 });
page.on("error", (e) => console.log("PAGE CRASH", String(e)));
page.on("close", () => console.log("PAGE CLOSED"));
page.on("framedetached", (f) => console.log("FRAME DETACHED", f === page.mainFrame() ? "main" : f.url()));
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)));
page.on("framenavigated", (f) => f === page.mainFrame() && console.log("NAVIGATED", f.url()));
page.on("console", (m) => /error|warn/.test(m.type()) && console.log("CONSOLE", m.type(), m.text().slice(0, 200)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (t) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll("button, a")].find((b) => b.textContent.trim().toLowerCase().startsWith(t.toLowerCase()));
    el?.click();
    return Boolean(el);
  }, t);
const verified = () => page.evaluate(() => (document.body.innerText.match(/\bverified\b/g) || []).length);
const up = async () => fetch(`${base}/api/network/state`).then((r) => r.ok, () => false);

await page.goto(`${base}/contribute`, { waitUntil: "domcontentloaded" });
await sleep(2500);
await click("Run benchmark");
await sleep(7500);
await click("Skip for now");
await sleep(600);
await click("Join network");
await sleep(12_000);
const before = await verified();
console.log("verified before restart:", before);
console.log("RESTART_NOW");
while (await up()) await sleep(250);
console.log("server down");
while (!(await up())) await sleep(500);
console.log("server up");
const v0 = await verified();
await sleep(30_000);
const after = await verified();
const text = await page.evaluate(() => document.body.innerText);
console.log("verified after restart (new jobs):", after - v0, "| error shown:", /unauthorized|halted/i.test(text));
await page.screenshot({ path: ".shots/recovery.png" });
await browser.close();
