// Dev utility: evaluates an expression on a page after load. node scripts/probe.mjs <url> "<js expr>"
import puppeteer from "puppeteer-core";

const [url, expr] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 960 });
await p.goto(url, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 5000));
console.log(JSON.stringify(await p.evaluate(expr), null, 1));
await b.close();
