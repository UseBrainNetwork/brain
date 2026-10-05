import { ImageResponse } from "next/og";

export const alt = "BRAIN — Compute from everywhere";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function tone(i: number) {
  const h = (Math.imul(i + 1, 2654435761) >>> 16) % 100;
  return h < 7 ? "#3d5afe" : h < 30 ? "rgba(230,233,238,0.55)" : "rgba(230,233,238,0.12)";
}

export default function OpengraphImage() {
  const cells = Array.from({ length: 22 * 9 }, (_, i) => i);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0b0d11", color: "#e6e9ee", padding: 72, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 620 }}>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 4, color: "#3d5afe" }}>DISTRIBUTED AI COMPUTE</div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 96, fontWeight: 800, lineHeight: 0.95, letterSpacing: -4 }}>
            <span>Compute</span>
            <span style={{ color: "rgba(230,233,238,0.45)" }}>from everywhere.</span>
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "rgba(230,233,238,0.6)" }}>Contribute WebGPU compute. Earn credits, USDC or SOL.</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", width: 22 * 18, alignContent: "center", marginLeft: "auto", gap: 4 }}>
          {cells.map((i) => (
            <div
              key={i}
              style={{ width: 14, height: 14, borderRadius: 2, background: tone(i) }}
            />
          ))}
        </div>
      </div>
    ),
    size,
  );
}
