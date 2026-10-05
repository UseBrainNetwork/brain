// Dev utility: runs the inference playground once and screenshots the result.
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:3100";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", args: ["--hide-scrollbars"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 1000 });
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));
await p.goto(`${base}/inference`, { waitUntil: "networkidle2" });
await p.evaluate(() => document.getElementById("playground").scrollIntoView());
await new Promise((r) => setTimeout(r, 800));
const [btn] = await p.$$("xpath/.//button[contains(., 'Run on Brain')]");
await btn.click();
await new Promise((r) => setTimeout(r, 900));
await p.screenshot({ path: ".shots/play1-running.png" });
await new Promise((r) => setTimeout(r, 2500));
await p.screenshot({ path: ".shots/play2-result.png" });
console.log(errors.length ? errors : "no page errors");
await b.close();
