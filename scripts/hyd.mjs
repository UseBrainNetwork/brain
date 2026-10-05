import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
const p = await b.newPage();
p.on("console", (m) => { if (m.type()==="error") console.log(m.text().slice(0, 6000)); });
p.on("requestfailed", r => console.log("FAILED", r.url()));
p.on("response", r => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
await p.goto(process.argv[2] ?? "http://localhost:3100/", { waitUntil: "domcontentloaded" });
await new Promise(r => setTimeout(r, 3000));
await b.close();
