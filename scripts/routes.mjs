// Dev utility: loads every route, reports HTTP status, page errors and console errors (incl. hydration).
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3100";
const mobile = process.argv.includes("--mobile");
const routes = ["/", "/brain", "/contribute", "/inference", "/explorer", "/explorer/job/918240", "/explorer/job/5000001", "/explorer/job/abc", "/rewards", "/economics", "/developers", "/auto", "/capacity", "/network", "/demo", "/node", "/receipt/r-nope", "/node/nope", "/epoch/nope", "/nope"];
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--hide-scrollbars"] });
let bad = 0;
for (const r of routes) {
  const p = await b.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } : { width: 1440, height: 960 });
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 300)));
  p.on("console", (m) => m.type() === "error" && !m.text().includes("404") && errs.push(m.text().slice(0, 300)));
  const res = await p.goto(base + r, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((x) => setTimeout(x, 2500));
  const overflow = await p.evaluate((vw) => Math.max(document.documentElement.scrollWidth, window.innerWidth) - vw, mobile ? 390 : 1440);
  if (errs.length || overflow > 0) bad++;
  console.log(`${res.status()} ${r}${overflow > 0 ? ` HORIZONTAL OVERFLOW ${overflow}px` : ""}${errs.length ? `\n   ${errs.join("\n   ")}` : ""}`);
  await p.close();
}
await b.close();
console.log(bad ? `${bad} route(s) with problems` : "all routes clean");
