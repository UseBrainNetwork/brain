// Dev utility: captures a scroll sequence for checking scroll-scrubbed scenes. Usage:
//   node scripts/scrollseq.mjs [url] [fromVh] [toVh] [steps] [--mobile]
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mobile = process.argv.includes("--mobile");
const [url = "http://localhost:3100/", from = "0", to = "2.4", steps = "12"] = args;
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--hide-scrollbars"],
});
const p = await browser.newPage();
await p.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(url, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 3500));
fs.mkdirSync(".shots/seq", { recursive: true });
for (const f of fs.readdirSync(".shots/seq")) fs.unlinkSync(`.shots/seq/${f}`);
const vh = mobile ? 844 : 900;
const n = Number(steps);
for (let i = 0; i < n; i++) {
  const y = Math.round((Number(from) + ((Number(to) - Number(from)) * i) / (n - 1)) * vh);
  await p.evaluate((y) => window.scrollTo(0, y), y);
  await new Promise((r) => setTimeout(r, 450));
  await p.screenshot({ path: `.shots/seq/s_${String(i).padStart(2, "0")}.png` });
}
console.log(errors.length ? `ERRORS: ${errors.join(" | ")}` : `ok ${n} frames`);
await browser.close();
