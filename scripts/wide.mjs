// Dev utility: lists elements wider than a 390px mobile viewport.
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new" });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await p.goto(process.argv[2], { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 4000));
console.log(await p.evaluate(() => {
  const out = [`innerWidth=${innerWidth} scrollWidth=${document.documentElement.scrollWidth} visual=${visualViewport.width}`];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.right > 392 && !el.closest("header") && !el.closest(".ticker")) out.push(`${el.tagName}.${String(el.className).slice(0, 80)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    if (out.length > 400) break;
  }
  return out.join("\n");
}));
await b.close();
