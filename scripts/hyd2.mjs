// Dev utility: loads a route repeatedly and prints the full text of any hydration error.
import puppeteer from "puppeteer-core";
const url = process.argv[2];
const n = Number(process.argv[3] ?? 4);
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
for (let i = 0; i < n; i++) {
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 960 });
  p.on("console", (m) => { if (m.type() === "error" && /hydrat/i.test(m.text())) console.log(`[run ${i}]`, m.text()); });
  p.on("pageerror", (e) => { if (/hydrat/i.test(String(e))) console.log(`[run ${i}] PAGEERROR`, String(e)); });
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 3500));
  await p.close();
}
await b.close();
