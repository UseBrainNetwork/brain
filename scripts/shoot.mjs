// Dev utility: screenshots routes with the system Chrome. Usage:
//   node scripts/shoot.mjs [baseUrl] [route ...] [--mobile] [--full] [--wait=ms]
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const rest = args.filter((a) => !a.startsWith("--"));
const base = rest[0] ?? "http://localhost:3100";
const routes = rest.slice(1).length ? rest.slice(1) : ["/"];
const mobile = flags.has("--mobile");
const full = flags.has("--full");
const wait = Number([...flags].find((f) => f.startsWith("--wait="))?.split("=")[1] ?? 2500);
const dpr = Number([...flags].find((f) => f.startsWith("--dpr="))?.split("=")[1] ?? 1);
const scrollTo = Number([...flags].find((f) => f.startsWith("--scroll="))?.split("=")[1] ?? 0);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--hide-scrollbars"],
});
fs.mkdirSync(".shots", { recursive: true });
for (const r of routes) {
  const page = await browser.newPage();
  await page.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } : { width: 1440, height: 960, deviceScaleFactor: dpr });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(base + r, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (scrollTo) await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
  await new Promise((res) => setTimeout(res, wait));
  const name = `.shots/${(r.replace(/[/#?=]+/g, "_") || "_home").replace(/^_$/, "_home")}${mobile ? "-m" : ""}${scrollTo ? `-y${scrollTo}` : ""}.png`;
  await page.screenshot({ path: name, fullPage: full });
  console.log(name, errors.length ? `ERRORS: ${errors.join(" | ").slice(0, 800)}` : "ok");
  await page.close();
}
await browser.close();
