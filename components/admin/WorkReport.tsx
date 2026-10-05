"use client";

import { useCallback, useEffect, useState } from "react";
import { Prov } from "@/components/ui";
import { cx, fmtInt, fmtPct, fmtSol, shortAddr } from "@/lib/format";
import type { EpochWorkReport } from "@/services/settlement";

const KEY = "brain.adminToken";

/** Operator view: who did work this epoch, who is linked, who gets paid. Token stays in this browser. */
export function WorkReport() {
  const [token, setToken] = useState("");
  const [epoch, setEpoch] = useState("current");
  const [data, setData] = useState<EpochWorkReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setToken(sessionStorage.getItem(KEY) ?? ""), []);

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/work?epoch=${encodeURIComponent(epoch)}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "request_failed");
      sessionStorage.setItem(KEY, token);
      setData(j as EpochWorkReport);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }, [token, epoch]);

  useEffect(() => {
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  const walletOf = (w: string) => data?.wallets.find((x) => x.wallet === w);

  return (
    <div data-theme="dark" className="surface-dark min-h-dvh px-6 py-10 font-mono text-[13px] text-chalk md:px-10">
      <div className="label text-chalk/50">Operator · epoch work</div>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="BRAIN_ADMIN_TOKEN"
          className="h-10 w-[320px] rounded-lg border border-chalk/15 bg-ink-2 px-3 text-chalk placeholder:text-chalk/30"
        />
        <select value={epoch} onChange={(e) => setEpoch(e.target.value)} className="h-10 rounded-lg border border-chalk/15 bg-ink-2 px-3 text-chalk">
          <option value="current">current epoch</option>
          <option value="last">last epoch</option>
          {[2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={String(Date.now() - n * 3_600_000)}>
              {n} epochs ago
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || !token} className="h-10 rounded-lg bg-chalk px-4 font-sans font-semibold text-ink disabled:opacity-40">
          {busy ? "Loading…" : "Load"}
        </button>
        {err && <span className="text-signal">{err}</span>}
      </form>

      {data && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-px bg-chalk/[0.07] md:grid-cols-5">
            {[
              ["Epoch", data.epochId.slice(2)],
              ["State", data.state],
              ["Pool", fmtSol(data.poolLamports)],
              ["Network verified units", fmtInt(data.networkVerifiedCompute)],
              ["Unlinked", `${data.unlinked.nodes} nodes · ${fmtInt(data.unlinked.verifiedCompute)} units · earn 0`],
            ].map(([k, v]) => (
              <div key={k} className="bg-ink px-4 py-3">
                <div className="label text-chalk/45">{k}</div>
                <div className="mt-1 text-[15px]">{v}</div>
              </div>
            ))}
          </div>

          <h2 className="label mt-10 text-chalk/50">Payout by wallet {data.state === "settled" ? <Prov p="live" /> : <Prov p="estimated" />}</h2>
          <table className="mt-3 w-full border-collapse text-left">
            <thead className="text-chalk/45">
              <tr>
                {["Wallet", "Nodes", "Verified units", "Share", "Multiplier", "SOL", ""].map((h) => (
                  <th key={h} className="border-b border-chalk/10 py-2 pr-4 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.wallets.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-3 text-chalk/50">
                    No linked wallet did verified work in this epoch. Pool stays in the treasury.
                  </td>
                </tr>
              )}
              {data.wallets.map((w) => (
                <tr key={w.wallet} className={cx(!w.eligible && "text-chalk/40")}>
                  <td className="py-2 pr-4" title={w.wallet}>
                    {shortAddr(w.wallet)}
                  </td>
                  <td className="py-2 pr-4">{w.nodes.join(", ")}</td>
                  <td className="py-2 pr-4">{fmtInt(w.verifiedCompute)}</td>
                  <td className="py-2 pr-4">{fmtPct(w.share, 1)}</td>
                  <td className="py-2 pr-4">{w.multiplier.toFixed(2)}×</td>
                  <td className={cx("py-2 pr-4", w.lamports > 0 && "text-ok")}>{fmtSol(w.lamports)}</td>
                  <td className="py-2 text-chalk/45">{!w.eligible ? "ineligible" : w.capped ? "capped" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 className="label mt-10 text-chalk/50">Nodes that did work</h2>
          <table className="mt-3 w-full border-collapse text-left">
            <thead className="text-chalk/45">
              <tr>
                {["Node", "Device", "Jobs", "Verified", "Units", "Availability", "Reputation", "Wallet", "Gets paid"].map((h) => (
                  <th key={h} className="border-b border-chalk/10 py-2 pr-4 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => {
                const w = n.walletVerified && n.wallet ? walletOf(n.wallet) : null;
                return (
                  <tr key={n.nodeId} className={cx(!n.walletVerified && "text-chalk/45")}>
                    <td className="py-2 pr-4">{n.nodeId}</td>
                    <td className="py-2 pr-4">{n.deviceClass}</td>
                    <td className="py-2 pr-4">{fmtInt(n.jobs)}</td>
                    <td className="py-2 pr-4">{fmtInt(n.verifiedJobs)}</td>
                    <td className="py-2 pr-4">{fmtInt(n.verifiedCompute)}</td>
                    <td className="py-2 pr-4">{fmtPct(n.availability, 0)}</td>
                    <td className="py-2 pr-4">{n.reputation.toFixed(2)}</td>
                    <td className="py-2 pr-4" title={n.wallet ?? ""}>
                      {n.wallet ? shortAddr(n.wallet) : "—"}
                      {n.wallet && !n.walletVerified && " (unverified)"}
                    </td>
                    <td className={cx("py-2", n.walletVerified ? "text-ok" : "text-warn")}>{n.walletVerified ? (w && w.eligible ? "yes" : "linked, ineligible") : "no · not linked"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
