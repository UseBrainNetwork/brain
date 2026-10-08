import { cx } from "@/lib/format";

const fmt = (lamports: number, digits = 3) => (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: digits });

/**
 * Server-rendered bar charts, no client JS. Every bar is a real number; an empty day is an empty
 * slot, not a smoothed line through it.
 */
export function DailyPaid({ daily }: { daily: { day: string; lamports: number; payouts: number }[] }) {
  const top = Math.max(1, ...daily.map((d) => d.lamports));
  const total = daily.reduce((s, d) => s + d.lamports, 0);
  const active = daily.filter((d) => d.lamports > 0).length;
  return (
    <div>
      <div className="flex h-[140px] items-end gap-[3px] md:h-[180px]">
        {daily.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end">
            <div
              className={cx("w-full rounded-t-[3px] transition-colors", d.lamports > 0 ? "bg-ok/80 group-hover:bg-ok" : "bg-chalk/[0.06]")}
              style={{ height: d.lamports > 0 ? `${Math.max(3, (d.lamports / top) * 100)}%` : "2px" }}
            />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-chalk px-2.5 py-1.5 font-mono text-[10.5px] text-ink shadow-lg group-hover:block">
              {d.day} · {fmt(d.lamports, 4)} SOL · {d.payouts} payout{d.payouts === 1 ? "" : "s"}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-chalk/40">
        <span>{daily[0]?.day}</span>
        <span className="text-chalk/70">
          {fmt(total, 4)} SOL over {daily.length} days · paid on {active} of them
        </span>
        <span>{daily[daily.length - 1]?.day}</span>
      </div>
    </div>
  );
}

export function EpochBars({ epochs }: { epochs: { id: string; poolLamports: number; distributedLamports: number; participants: number; startsAt: number }[] }) {
  const rows = [...epochs].sort((a, b) => a.startsAt - b.startsAt).slice(-72);
  if (!rows.length) return <div className="flex h-[140px] items-center font-mono text-[12px] text-chalk/40">No live epoch has settled yet.</div>;
  const top = Math.max(1, ...rows.map((e) => e.poolLamports));
  return (
    <div>
      <div className="flex h-[140px] items-end gap-[2px] md:h-[180px]">
        {rows.map((e) => {
          const pool = Math.max(2, (e.poolLamports / top) * 100);
          const dist = e.poolLamports > 0 ? Math.max(0, Math.min(1, e.distributedLamports / e.poolLamports)) : 0;
          return (
            <div key={e.id} className="group relative flex h-full flex-1 items-end">
              <div className="relative w-full overflow-hidden rounded-t-[2px] bg-chalk/[0.08]" style={{ height: `${pool}%` }}>
                <div className="absolute inset-x-0 bottom-0 bg-signal/85 group-hover:bg-signal" style={{ height: `${dist * 100}%` }} />
              </div>
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-chalk px-2.5 py-1.5 font-mono text-[10.5px] text-ink shadow-lg group-hover:block">
                {e.id.replace(/^E-/, "")} · pool {fmt(e.poolLamports, 4)} · distributed {fmt(e.distributedLamports, 4)} · {e.participants} wallets
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-chalk/40">
        <span>{rows[0].id.replace(/^E-/, "").replace("T", " ")}</span>
        <span className="text-chalk/70">
          <span className="mr-1 inline-block size-[7px] bg-signal/85 align-middle" /> distributed
          <span className="ml-3 mr-1 inline-block size-[7px] bg-chalk/[0.12] align-middle" /> pool
        </span>
        <span>{rows[rows.length - 1].id.replace(/^E-/, "").replace("T", " ")}</span>
      </div>
    </div>
  );
}
