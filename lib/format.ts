export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");

export function fmtCompact(n: number, digits = 2): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return fmtInt(n);
}

export const fmtUsd = (n: number, digits = 0) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** Sub-cent amounts keep enough significant digits that per-job rewards never read as zero. */
export function fmtUsdSmall(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.000001) return `$${n.toFixed(Math.min(12, Math.ceil(-Math.log10(n)) + 1))}`;
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return fmtUsd(n);
}

export const fmtPct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`;

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

export function fmtBytes(b: number): string {
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)} GiB`;
  if (b >= 2 ** 20) return `${(b / 2 ** 20).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Lamports → SOL with precision that keeps small balances readable. */
export function fmtSol(lamports: number, unit = true): string {
  const sol = lamports / 1e9;
  const digits = sol === 0 ? 2 : Math.abs(sol) >= 100 ? 2 : Math.abs(sol) >= 1 ? 3 : Math.abs(sol) >= 0.01 ? 4 : 6;
  return `${sol.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit ? " SOL" : ""}`;
}
