// Generates animated SVGs for the GitHub README. Pure SVG + CSS animations (GitHub-safe: no scripts, no external assets).
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const INK = "#0b0d11", INK2 = "#11141a", CHALK = "#e6e9ee", FOG = "#7d8491", SIG = "#3d5afe", SIG2 = "#8ca0ff", OK = "#27c46d";
const SANS = `ui-sans-serif, -apple-system, 'Segoe UI', Inter, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const mkRnd = (seed) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

// ---------- hero.svg ----------
{
  const rnd = mkRnd(7);
  const W = 1200, H = 420;
  const cells = [];
  const cols = 34, rows = 14, cw = 11, gap = 3, x0 = 640, y0 = 70;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = x0 + c * (cw + gap), y = y0 + r * (cw + gap);
    const hot = rnd() < 0.16;
    const ok = !hot && rnd() < 0.03;
    const d = (rnd() * 7).toFixed(2), dur = (2.6 + rnd() * 4).toFixed(2);
    cells.push(`<rect x="${x}" y="${y}" width="${cw}" height="${cw}" rx="1.5" class="${hot ? "hot" : ok ? "ok" : "c"}" style="animation-delay:-${d}s;animation-duration:${dur}s"/>`);
  }
  const mark = (x, y, s, lit) => Array.from({ length: 9 }, (_, i) => `<rect x="${x + (i % 3) * 8 * s}" y="${y + Math.floor(i / 3) * 8 * s}" width="${6 * s}" height="${6 * s}" rx="${1.2 * s}" class="${i === lit ? "mk-lit" : "mk"}" style="animation-delay:${(i * 0.35).toFixed(2)}s"/>`).join("");
  const chips = ["WEBGPU", "SERVER-VERIFIED COMPUTE", "OPENAI-COMPATIBLE API", "PROOF-OF-COMPUTE RECEIPTS", "SOLANA SETTLEMENT"];
  let cx = 56; const chipEls = chips.map((t, i) => { const w = t.length * 7.6 + 26; const el = `<g style="animation-delay:${(0.9 + i * 0.12).toFixed(2)}s" class="chip"><rect x="${cx}" y="330" width="${w}" height="26" rx="13" fill="none" stroke="${CHALK}" stroke-opacity="0.16"/><text x="${cx + w / 2}" y="347" text-anchor="middle" font-family="${MONO}" font-size="10.5" letter-spacing="1" fill="${CHALK}" fill-opacity="0.65">${t}</text></g>`; cx += w + 10; return el; }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="brain — compute from everywhere">
<defs>
  <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${INK}" stop-opacity="1"/><stop offset="0.25" stop-color="${INK}" stop-opacity="0"/></linearGradient>
  <linearGradient id="fadeB" x1="0" y1="0" x2="0" y2="1"><stop offset="0.6" stop-color="${INK}" stop-opacity="0"/><stop offset="1" stop-color="${INK}" stop-opacity="1"/></linearGradient>
  <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><rect x="11" y="11" width="1.5" height="1.5" fill="${CHALK}" fill-opacity="0.08"/></pattern>
  <style>
    .c{fill:${CHALK};fill-opacity:.07}
    .hot{fill:${SIG};animation:heat 4s ease-in-out infinite}
    .ok{fill:${OK};animation:okp 5s ease-in-out infinite}
    @keyframes heat{0%,100%{fill-opacity:.08}40%{fill-opacity:.95}60%{fill-opacity:.7}}
    @keyframes okp{0%,100%{fill-opacity:.12}50%{fill-opacity:.85}}
    .mk{fill:${CHALK};animation:mk 3.2s ease-in-out infinite}
    .mk-lit{fill:${SIG}}
    @keyframes mk{0%,100%{fill-opacity:1}50%{fill-opacity:.55}}
    .rise{animation:rise .9s cubic-bezier(.2,.7,.2,1) both}
    @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
    .chip{opacity:0;animation:rise .7s cubic-bezier(.2,.7,.2,1) both}
    .cur{animation:blink 1s steps(1) infinite}
    @keyframes blink{50%{opacity:0}}
    .scan{animation:scan 6s linear infinite}
    @keyframes scan{from{transform:translateY(-20px)}to{transform:translateY(${H + 20}px)}}
  </style>
</defs>
<rect width="${W}" height="${H}" fill="${INK}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<g>${cells.join("")}</g>
<rect x="600" y="0" width="300" height="${H}" fill="url(#fade)"/>
<rect x="600" y="0" width="600" height="${H}" fill="url(#fadeB)"/>
<g class="scan"><rect x="640" y="0" width="${cols * (cw + gap)}" height="1" fill="${SIG}" fill-opacity="0.35"/></g>
<g class="rise" style="animation-delay:.05s">${mark(56, 58, 1.6, 4)}<text x="100" y="86" font-family="${SANS}" font-weight="600" font-size="30" letter-spacing="-1.2" fill="${CHALK}">brain</text></g>
<g class="rise" style="animation-delay:.2s"><text x="54" y="190" font-family="${SANS}" font-weight="600" font-size="78" letter-spacing="-3.5" fill="${CHALK}">Compute</text><text x="54" y="268" font-family="${SANS}" font-weight="600" font-size="78" letter-spacing="-3.5" fill="${CHALK}">from everywhere.</text></g>
<g class="rise" style="animation-delay:.45s"><text x="56" y="304" font-family="${MONO}" font-size="13" fill="${FOG}">distributed AI compute · browsers contribute verified work · paid from real revenue<tspan class="cur" fill="${SIG}">▍</tspan></text></g>
${chipEls}
<text x="${W - 56}" y="${H - 28}" text-anchor="end" font-family="${MONO}" font-size="11" letter-spacing="1.5" fill="${FOG}" fill-opacity="0.8">brainnetwork.app</text>
</svg>`;
  fs.writeFileSync(path.join(out, "hero.svg"), svg);
}

// ---------- trace.svg : everything on one T-second clock, one generated keyframe rule per element ----------
{
  const rnd = mkRnd(11);
  const W = 1200, H = 560, T = 11;
  const col = { req: 70, gate: 250, route: 430, nodes: 660, merge: 890, resp: 1080 };
  const midY = 280;
  const nodes = ["8A21", "19F2", "81CC", "28AA"];
  const nodeY = nodes.map((_, i) => 100 + i * 120);
  const tileW = 150, tileH = 86;
  const RESET = T - 0.6; // everything fades out for the last 0.6s, then the loop restarts

  const css = [];
  let n = 0;
  const P = (s) => `${Math.max(0, Math.min(100, (s / T) * 100)).toFixed(3)}%`;
  /** register a T-second keyframe animation; frames = [[seconds, cssProps]] */
  const anim = (frames, timing = "linear") => {
    const id = `k${n++}`;
    const sorted = [...frames].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) if (sorted[i][0] <= sorted[i - 1][0]) sorted[i] = [sorted[i - 1][0] + 0.002, sorted[i][1]];
    const rules = sorted.map(([s, p]) => `${P(s)}{${p}}`).join("");
    css.push(`@keyframes ${id}{${rules}}.${id}{animation:${id} ${T}s ${timing} infinite both}`);
    return id;
  };
  const EPS = 0.01;
  const popAt = (t, from = "opacity:0;transform:translateY(3px)", to = "opacity:1;transform:none") =>
    anim([[0, from], [t, from], [t + 0.25, to], [RESET, to], [RESET + 0.3, from], [T, from]], "ease-out");
  const hideAfter = (t, from = "opacity:1", to = "opacity:.22") => anim([[0, from], [t, from], [t + 0.3, to], [RESET, to], [RESET + 0.3, from], [T, from]]);

  const bez = (a, b, c, d, t) => { const u = 1 - t; return { x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x, y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y }; };
  const hcurve = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: (x1 + x2) / 2, y: y1 }, { x: (x1 + x2) / 2, y: y2 }, { x: x2, y: y2 }];
  const dOf = (c) => `M${c[0].x},${c[0].y} C${c[1].x},${c[1].y} ${c[2].x},${c[2].y} ${c[3].x},${c[3].y}`;

  /** a segment that draws itself from t0..t1, carries flowing dashes afterwards, with a packet riding the draw */
  const flow = (c, t0, t1, color) => {
    const d = dOf(c);
    const draw = anim([[0, "stroke-dashoffset:100"], [t0, "stroke-dashoffset:100"], [t1, "stroke-dashoffset:0"], [RESET, "stroke-dashoffset:0"], [RESET + 0.3, "stroke-dashoffset:100"], [T, "stroke-dashoffset:100"]], "cubic-bezier(.4,0,.2,1)");
    const gate = anim([[0, "opacity:0"], [t1, "opacity:0"], [t1 + EPS, "opacity:.9"], [RESET, "opacity:.9"], [RESET + 0.3, "opacity:0"], [T, "opacity:0"]]);
    const steps = 14;
    const pk = anim([[0, "opacity:0;transform:translate(" + c[0].x + "px," + c[0].y + "px)"], [t0 - EPS, "opacity:0;transform:translate(" + c[0].x + "px," + c[0].y + "px)"],
      ...Array.from({ length: steps + 1 }, (_, i) => { const p = bez(...c, i / steps); return [t0 + (i / steps) * (t1 - t0), `opacity:1;transform:translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`]; }),
      [t1 + 0.12, `opacity:0;transform:translate(${c[3].x}px,${c[3].y}px)`], [T, `opacity:0;transform:translate(${c[3].x}px,${c[3].y}px)`]]);
    return `<path d="${d}" fill="none" stroke="${CHALK}" stroke-opacity=".08"/>
<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" pathLength="100" stroke-dasharray="100 100" class="${draw}"/>
<g class="${gate}"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" pathLength="100" stroke-dasharray="2 9" class="dash"/></g>
<g class="${pk}"><circle r="9" fill="${color}" fill-opacity=".35"/><circle r="2.6" fill="#fff"/></g>`;
  };
  const line = (x1, y1, x2, y2) => [{ x: x1, y: y1 }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x2, y: y2 }];
  const label = (x, y, text, o = {}) => `<text x="${x}" y="${y}" text-anchor="${o.anchor ?? "middle"}" font-family="${MONO}" font-size="${o.size ?? 10}" letter-spacing="${o.ls ?? 1}" font-weight="${o.w ?? 500}" fill="${o.fill ?? FOG}"${o.cls ? ` class="${o.cls}"` : ""}>${text}</text>`;
  const stage = (x, text) => label(x, 36, text, { fill: CHALK, size: 10.5, ls: 2 });

  const t = { req: 0.3, gate: 1.2, route: 2.1, pick: 3.1, split: 3.5, nodesIn: 4.4, verify: 5.6, verified: 7.3, merge: 7.4, mergeDone: 8.3, resp: 8.9 };

  let body = "";
  body += stage(col.req, "REQUEST") + stage(col.gate, "GATEWAY") + stage(col.route, "ROUTER") + stage(col.nodes + tileW / 2, "NODES · VERIFY") + stage(col.merge, "MERGE") + stage(col.resp, "RESPONSE");

  // request
  body += `<g class="${popAt(t.req)}"><rect x="${col.req - 58}" y="${midY - 16}" width="116" height="32" rx="7" fill="${SIG}" fill-opacity=".14" stroke="${SIG}"/>${label(col.req, midY + 4, "POST /v1/chat", { fill: CHALK, size: 11, ls: 0.5 })}</g>`;
  body += flow(line(col.req + 58, midY, col.gate - 40, midY), t.req, t.gate, SIG);

  // gateway (drawn after the incoming spine so label backings sit on top of it)
  body += flow(line(col.gate - 40, midY, col.route - 70, midY), t.gate + 0.7, t.route, SIG);
  body += `<rect x="${col.gate - 40}" y="${midY - 90}" width="1" height="180" fill="${CHALK}" fill-opacity=".2"/>`;
  ["AUTH", "RATE 18/60", "SCHEMA"].forEach((c, i) => {
    const y = midY - 50 + i * 50, d = t.gate + 0.15 + i * 0.22;
    body += `<rect x="${col.gate - 22}" y="${y - 4}" width="8" height="8" fill="${CHALK}" fill-opacity=".15"/><g class="${popAt(d, "opacity:0", "opacity:1")}"><rect x="${col.gate - 22}" y="${y - 4}" width="8" height="8" fill="${OK}"/><circle cx="${col.gate - 18}" cy="${y}" r="14" fill="${OK}" fill-opacity=".18"/></g><rect x="${col.gate - 10}" y="${y - 8}" width="${c.length * 6.6 + 8}" height="16" fill="${INK}"/>${label(col.gate - 8, y + 4, c, { anchor: "start", size: 9.5, fill: CHALK, cls: "dim" })}`;
  });

  // router
  const cands = [["CLOUD_GPU", "$0.0090 · 0.9s", -70], ["BROWSER_NETWORK", "$0.0021 · 1.8s", 0], ["EXTERNAL", "$0.0150 · 1.1s", 70]];
  cands.forEach(([k, c, dy]) => {
    const chosen = dy === 0, y = midY + dy;
    const cv = hcurve(col.route - 70, midY, col.route - 10, y);
    const show = anim([[0, "stroke-dashoffset:100"], [t.route, "stroke-dashoffset:100"], [t.route + 0.5, "stroke-dashoffset:0"], [RESET, "stroke-dashoffset:0"], [RESET + 0.3, "stroke-dashoffset:100"], [T, "stroke-dashoffset:100"]]);
    body += `<path d="${dOf(cv)}" fill="none" stroke="${CHALK}" stroke-opacity=".2" pathLength="100" stroke-dasharray="100 100" class="${show} ${chosen ? "" : hideAfter(t.pick, "opacity:1", "opacity:.3")}"/>`;
    if (chosen) body += flow(cv, t.pick, t.pick + 0.3, SIG);
    body += `<g class="${popAt(t.route + 0.4)}"><g class="${chosen ? "" : hideAfter(t.pick)}"><rect x="${col.route - 13}" y="${y - 3}" width="6" height="6" fill="${chosen ? SIG : CHALK}" fill-opacity="${chosen ? 1 : 0.6}"/>${label(col.route, y - 3, k, { anchor: "start", size: 9.5, w: 600, fill: chosen ? SIG2 : CHALK })}${label(col.route, y + 10, c, { anchor: "start", size: 9, fill: FOG })}</g></g>`;
    if (chosen) body += `<g class="${popAt(t.pick + 0.2)}"><rect x="${col.route + 122}" y="${y - 12}" width="66" height="15" rx="3" fill="${SIG}" fill-opacity=".2"/>${label(col.route + 155, y - 1, "CHEAPEST", { size: 8.5, w: 600, fill: SIG2 })}</g>`;
  });

  // split fan → tiles
  const fanX0 = col.route + 200;
  body += flow(line(col.route + 118, midY, fanX0, midY), t.pick + 0.3, t.split, SIG);
  body += `<g class="${popAt(t.split, "opacity:0", "opacity:1")}"><rect x="${fanX0 - 3}" y="${midY - 3}" width="6" height="6" fill="${SIG}"/><circle cx="${fanX0}" cy="${midY}" r="16" fill="${SIG}" fill-opacity=".2"/></g>`;
  nodes.forEach((id, i) => {
    const ty = nodeY[i], cy = ty + tileH / 2;
    const arrive = t.nodesIn + i * 0.08;
    body += flow(hcurve(fanX0, midY, col.nodes, cy), t.split + i * 0.08, arrive, SIG);
    const cells = [];
    const cols = 12, rows = 4, cw = 8, gp = 2, gx = col.nodes + 10, gy = ty + 24;
    const scan = t.verify + i * 0.4;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const hot = rnd() < 0.55;
      const base = `fill:${CHALK};fill-opacity:.07`;
      const settle = arrive + 0.05 + rnd() * 0.4;
      const frames = [[0, base], [settle, base]];
      if (hot) {
        let s = settle + 0.05 + rnd() * 0.4;
        while (s < scan - 0.2) { frames.push([s, `fill:${SIG};fill-opacity:${(0.55 + rnd() * 0.45).toFixed(2)}`]); s += 0.18 + rnd() * 0.3; frames.push([Math.min(s, scan - 0.2), `fill:${SIG};fill-opacity:${(0.15 + rnd() * 0.3).toFixed(2)}`]); s += 0.1 + rnd() * 0.25; }
      }
      const rowT = scan + (r / rows) * 0.45;
      frames.push([rowT - EPS, hot ? `fill:${SIG};fill-opacity:.3` : base], [rowT, `fill:${OK};fill-opacity:.9`], [rowT + 0.18, `fill:${OK};fill-opacity:${(0.18 + rnd() * 0.14).toFixed(2)}`], [RESET, `fill:${OK};fill-opacity:.25`], [RESET + 0.3, base], [T, base]);
      cells.push(`<rect x="${gx + c * (cw + gp)}" y="${gy + r * (cw + gp)}" width="${cw}" height="${cw}" rx="1" class="${anim(frames)}"/>`);
    }
    const bar = anim([[0, "transform:scaleX(0)"], [arrive, "transform:scaleX(0)"], [scan, "transform:scaleX(1)"], [RESET, "transform:scaleX(1)"], [RESET + 0.3, "transform:scaleX(0)"], [T, "transform:scaleX(0)"]]);
    body += `<g>
<rect x="${col.nodes}" y="${ty}" width="${tileW}" height="${tileH}" rx="6" fill="${INK2}" stroke="${CHALK}" stroke-opacity=".18"/>
<g class="${popAt(arrive, "opacity:0", "opacity:1")}"><rect x="${col.nodes}" y="${ty}" width="${tileW}" height="${tileH}" rx="6" fill="${SIG}" fill-opacity=".05" stroke="${SIG}" stroke-opacity=".7"/></g>
<g class="${popAt(scan + 0.5, "opacity:0", "opacity:1")}"><rect x="${col.nodes}" y="${ty}" width="${tileW}" height="${tileH}" rx="6" fill="${OK}" fill-opacity=".06" stroke="${OK}" stroke-opacity=".95"/></g>
${label(col.nodes + 10, ty + 15, `NODE ${id}`, { anchor: "start", size: 9.5, w: 600, fill: CHALK })}
<g class="${popAt(arrive)}">${label(col.nodes + tileW - 10, ty + 15, `UNIT ${"ABCD"[i]}`, { anchor: "end", size: 9, fill: SIG2 })}</g>
<g>${cells.join("")}</g>
<rect x="${col.nodes + 10}" y="${ty + tileH - 10}" width="${tileW - 20}" height="2" fill="${CHALK}" fill-opacity=".1"/>
<rect x="${col.nodes + 10}" y="${ty + tileH - 10}" width="${tileW - 20}" height="2" fill="${SIG}" class="${bar}" style="transform-origin:${col.nodes + 10}px ${ty + tileH - 9}px"/>
<g class="${popAt(scan + 0.5)}">${label(col.nodes + tileW - 10, ty + tileH - 15, "SPOT-CHECK 8/8", { anchor: "end", size: 8.5, w: 600, fill: OK })}</g>
<g class="${popAt(t.resp + 0.3)}">${label(col.nodes + tileW + 12, ty + 14, "+8u", { anchor: "start", size: 11, w: 600, fill: OK })}</g>
</g>`;
    body += flow(hcurve(col.nodes + tileW, cy, col.merge, midY), t.merge + i * 0.08, t.mergeDone + i * 0.08, OK);
  });

  // merge + response
  body += `<g class="${popAt(t.mergeDone + 0.2, "opacity:0", "opacity:1")}"><rect x="${col.merge - 3}" y="${midY - 3}" width="6" height="6" fill="${OK}"/><circle cx="${col.merge}" cy="${midY}" r="18" fill="${OK}" fill-opacity=".18"/></g>`;
  body += `<g class="${popAt(t.mergeDone + 0.3)}">${label(col.merge, midY + 24, "4/4 in order", { size: 9, fill: CHALK })}${label(col.merge, midY + 37, "hash 9f3c…e1a0", { size: 9 })}</g>`;
  body += flow(line(col.merge, midY, col.resp - 78, midY), t.mergeDone + 0.3, t.resp, OK);
  const ring = anim([[0, "opacity:0;transform:scale(1)"], [t.resp - EPS, "opacity:0;transform:scale(1)"], [t.resp, "opacity:.9;transform:scale(1)"], [t.resp + 0.9, "opacity:0;transform:scale(1.3)"], [T, "opacity:0;transform:scale(1.3)"]], "ease-out");
  body += `<g class="${popAt(t.resp)}"><rect x="${col.resp - 78}" y="${midY - 16}" width="156" height="32" rx="7" fill="${OK}" fill-opacity=".12" stroke="${OK}"/>${label(col.resp, midY + 4, "200 OK · r-918282", { fill: CHALK, size: 11, ls: 0.5 })}${label(col.resp, midY + 32, "1.79s · receipt issued", { size: 9 })}</g>`;
  body += `<rect x="${col.resp - 78}" y="${midY - 16}" width="156" height="32" rx="7" fill="none" stroke="${OK}" class="${ring}" style="transform-origin:${col.resp}px ${midY}px"/>`;

  // footer log (one line visible at a time)
  const logs = [[t.req, "0.000s  POST /v1/chat/completions  model=brain/auto  priority=cheap"], [t.gate + 0.4, "0.004s  auth ok · rate 18/60 · schema ok · usage meter armed"], [t.pick, "0.012s  route → BROWSER_NETWORK  (cheapest valid target)"], [t.nodesIn, "0.029s  job #918282 split → 4 units · dispatched to 4 nodes"], [t.verify + 0.2, "1.210s  server recomputes secret rows · spot-check 32/32 VERIFIED"], [t.resp, "1.794s  200 OK · receipt r-918282 · credit 4 × +8u"]];
  body += `<rect x="40" y="${H - 44}" width="${W - 80}" height="1" fill="${CHALK}" fill-opacity=".1"/>`;
  logs.forEach(([d, s], i) => {
    const next = i + 1 < logs.length ? logs[i + 1][0] : RESET;
    const k = anim([[0, "opacity:0"], [d, "opacity:0"], [d + EPS, "opacity:1"], [next, "opacity:1"], [next + EPS, "opacity:0"], [T, "opacity:0"]]);
    body += `<text x="40" y="${H - 20}" font-family="${MONO}" font-size="11" fill="${CHALK}" fill-opacity=".85" class="${k}">${s}</text>`;
  });
  body += label(W - 40, H - 20, "example trace · values illustrative", { anchor: "end", size: 9.5 });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="One request traced through the brain network">
<defs>
  <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><rect x="11" y="11" width="1.5" height="1.5" fill="${CHALK}" fill-opacity="0.08"/></pattern>
  <style>
    .dash{animation:dashflow .9s linear infinite}
    @keyframes dashflow{to{stroke-dashoffset:-22}}
    .dim{fill-opacity:.55}
    ${css.join("\n    ")}
  </style>
</defs>
<rect width="${W}" height="${H}" fill="${INK}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
${body}
</svg>`;
  fs.writeFileSync(path.join(out, "trace.svg"), svg);
}

// ---------- divider.svg : a thin line with one packet travelling ----------
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 24" width="1200" height="24"><style>.p{animation:m 4s cubic-bezier(.6,0,.4,1) infinite}@keyframes m{from{transform:translateX(0)}to{transform:translateX(1200px)}}</style><rect x="0" y="11.5" width="1200" height="1" fill="#7d8491" fill-opacity=".25"/><g class="p"><rect x="-60" y="11" width="60" height="2" fill="url(#g)"/><circle cx="0" cy="12" r="2.5" fill="#fff"/></g><defs><linearGradient id="g"><stop offset="0" stop-color="#3d5afe" stop-opacity="0"/><stop offset="1" stop-color="#3d5afe"/></linearGradient></defs></svg>`;
  fs.writeFileSync(path.join(out, "divider.svg"), svg);
}

for (const f of fs.readdirSync(out)) console.log(f, fs.statSync(path.join(out, f)).size);
