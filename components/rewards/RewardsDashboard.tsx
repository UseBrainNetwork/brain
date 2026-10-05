"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RewardClaim, RewardsSummary } from "@/domain/types";
import { Button, Prov } from "@/components/ui";
import { WalletButton } from "@/components/wallet/WalletButton";
import { useWallet, walletStore } from "@/lib/wallet/store";
import { cx, fmtCompact, fmtDuration, fmtSol, shortAddr } from "@/lib/format";

type ClaimState = { step: "idle" } | { step: "preparing" | "signing" | "sending" } | { step: "done"; claim: RewardClaim } | { step: "error"; message: string };

const ERRORS: Record<string, string> = {
  payouts_disabled: "Payouts are not open yet.",
  nothing_to_claim: "Nothing to claim yet.",
  claim_in_progress: "A claim for this wallet is already in progress.",
  insufficient_balance: "Your balance changed. Refresh and try again.",
  claim_expired: "The claim request expired. Try again.",
  bad_signature: "The signature did not match this wallet.",
  daily_payout_cap: "Today's payout limit has been reached. Try again tomorrow.",
  rate_limited: "Too many requests. Wait a minute and try again.",
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "request_failed");
  return j as T;
}

const txUrl = (sig: string, cluster: string) => `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;

export function RewardsDashboard() {
  const w = useWallet();
  const address = w.status === "connected" ? w.address : null;
  const [data, setData] = useState<RewardsSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [claim, setClaim] = useState<ClaimState>({ step: "idle" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const r = await fetch(`/api/rewards/summary?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      if (!r.ok) throw new Error();
      setData((await r.json()) as RewardsSummary);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [address]);

  useEffect(() => {
    setData(null);
    setClaim({ step: "idle" });
    if (!address) return;
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [address, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!address) return <ConnectPrompt />;
  if (!data) return <Skeleton error={loadError} />;

  const canSign = w.verified;
  const blocked = !data.payouts.enabled
    ? data.payouts.reason
    : !canSign
      ? "Connect a wallet that can sign (Phantom, Solflare or Backpack) to claim."
      : data.claimableLamports < data.payouts.minLamports
        ? `Claims open at ${fmtSol(data.payouts.minLamports)}.`
        : null;
  const busy = claim.step === "preparing" || claim.step === "signing" || claim.step === "sending";

  async function onClaim() {
    if (!address) return;
    try {
      setClaim({ step: "preparing" });
      const { message } = await post<{ message: string; lamports: number }>("/api/rewards/claim/nonce", { address });
      setClaim({ step: "signing" });
      const signature = await walletStore.sign(message);
      setClaim({ step: "sending" });
      const res = await post<{ claim: RewardClaim }>("/api/rewards/claim", { address, message, signature });
      if (res.claim.status === "failed") setClaim({ step: "error", message: "The payout transaction failed. Your balance was not used." });
      else setClaim({ step: "done", claim: res.claim });
      load();
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setClaim({ step: "error", message: ERRORS[code] ?? (code.toLowerCase().includes("reject") ? "Signature request was declined." : "Claim failed. Try again.") });
    }
  }

  const shown = data.demo ? data.demoLamports : data.claimableLamports;
  const cur = data.current;
  const elapsed = Math.min(1, Math.max(0, (now - cur.startsAt) / (cur.endsAt - cur.startsAt)));
  const maxEpoch = Math.max(1, ...data.epochs.map((e) => e.allocation.lamports));
  const paidEpochs = data.epochs.filter((e) => e.allocation.lamports > 0).length;
  const lifetime = data.demo ? data.demoLamports : data.earnedLamports + data.demoLamports;

  return (
    <div className="space-y-4">
      {data.demo && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/30 bg-warn/[0.06] px-5 py-3.5 text-[13.5px] text-chalk/75">
          <Prov p="simulated" />
          This wallet has no settled epochs yet, so the history below is demo data. It is not a balance and cannot be claimed.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
        {/* Claim */}
        <div className="relative overflow-hidden rounded-[28px] border border-chalk/10 bg-ink-2 p-7 md:p-9">
          <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-[360px] rounded-full bg-signal/[0.08] blur-[90px]" />
          <div className="relative flex items-center justify-between">
            <div className="label text-chalk/50">{data.demo ? "Demo balance" : "Claimable"}</div>
            <Prov p={data.demo ? "simulated" : "live"} />
          </div>
          <div className="relative mt-5 flex items-baseline gap-3">
            <span className="num text-[56px] font-medium leading-none tracking-[-0.03em] text-chalk md:text-[76px]">{fmtSol(shown, false)}</span>
            <span className="font-mono text-[15px] text-chalk/50">SOL</span>
          </div>
          <div className="relative mt-3 font-mono text-[12px] text-chalk/45">
            {fmtSol(data.claimedLamports)} claimed · {fmtSol(lifetime)} earned{data.demo ? " (demo)" : ""}
          </div>

          <div className="relative mt-8 flex flex-wrap items-center gap-4">
            <Button tone="dark" variant="signal" onClick={onClaim} disabled={Boolean(blocked) || data.demo || busy} className="h-12 px-7 text-[15px]">
              {claim.step === "preparing" ? "Preparing…" : claim.step === "signing" ? "Approve in wallet…" : claim.step === "sending" ? "Sending…" : "Claim now"}
            </Button>
            <span className="max-w-[340px] text-[13px] leading-snug text-chalk/50">
              {data.demo ? "Demo balances can never be claimed." : (blocked ?? `Pays ${fmtSol(Math.min(data.claimableLamports, data.payouts.maxLamports))} to ${shortAddr(address)}.`)}
            </span>
          </div>

          <AnimatePresence>
            {(claim.step === "done" || claim.step === "error") && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className={cx(
                  "relative mt-5 rounded-xl border px-4 py-3 text-[13.5px]",
                  claim.step === "done" ? "border-ok/30 bg-ok/[0.07] text-chalk/85" : "border-signal/30 bg-signal/[0.07] text-chalk/85",
                )}
              >
                {claim.step === "done" ? (
                  <>
                    Sent {fmtSol(claim.claim.lamports)}.{" "}
                    {claim.claim.txSignature && (
                      <a href={txUrl(claim.claim.txSignature, data.payouts.cluster)} target="_blank" rel="noreferrer" className="font-mono text-signal underline-offset-2 hover:underline">
                        View transaction ↗
                      </a>
                    )}
                  </>
                ) : (
                  claim.message
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Current epoch */}
        <div className="rounded-[28px] border border-chalk/10 bg-ink-2 p-7 md:p-9">
          <div className="flex items-center justify-between">
            <div className="label text-chalk/50">This epoch</div>
            <Prov p="estimated" />
          </div>
          <div className="mt-5 flex items-baseline gap-2">
            <span className="num text-[40px] font-medium leading-none tracking-[-0.02em] md:text-[48px]">{fmtSol(cur.projectedLamports, false)}</span>
            <span className="font-mono text-[13px] text-chalk/50">SOL accrued</span>
          </div>
          <div className="mt-6">
            <div className="flex justify-between font-mono text-[11px] text-chalk/45">
              <span>{cur.epochId}</span>
              <span suppressHydrationWarning>settles in {fmtDuration(Math.max(0, cur.endsAt - now))}</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-chalk/10">
              <div className="h-full rounded-full bg-signal transition-[width] duration-1000" style={{ width: `${elapsed * 100}%` }} />
            </div>
          </div>
          <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5">
            <Stat k="Verified units" v={fmtCompact(cur.verifiedCompute, 1)} />
            <Stat k="Network share" v={cur.networkVerifiedCompute > 0 ? `${((cur.verifiedCompute / cur.networkVerifiedCompute) * 100).toFixed(2)}%` : "—"} />
            <Stat k="Multiplier" v={cur.multiplier > 0 ? `${cur.multiplier.toFixed(2)}×` : "—"} />
            <Stat k="Availability" v={`${Math.round(cur.availability * 100)}%`} />
          </dl>
          {cur.verifiedCompute === 0 && (
            <Link href="/earn" className="mt-7 inline-flex items-center gap-1.5 text-[13.5px] text-signal hover:underline">
              Start contributing to accrue this epoch →
            </Link>
          )}
        </div>
      </div>

      {/* History */}
      <div className="rounded-[28px] border border-chalk/10 bg-ink-2 p-7 md:p-9">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="label text-chalk/50">Epoch history</div>
            <div className="mt-2 text-[15px] text-chalk/70">
              {paidEpochs} of {data.epochs.length} epochs paid
            </div>
          </div>
          <div className="flex h-12 items-end gap-[3px]" aria-hidden>
            {[...data.epochs].reverse().map((e) => (
              <div key={e.id} className="w-2.5 rounded-sm bg-signal/70" style={{ height: `${Math.max(4, (e.allocation.lamports / maxEpoch) * 100)}%`, opacity: e.allocation.lamports ? 1 : 0.2 }} />
            ))}
          </div>
        </div>
        {data.epochs.length === 0 ? (
          <p className="mt-8 text-[14px] text-chalk/50">No settled epochs yet. Rewards appear here after the first epoch you contribute to settles.</p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13.5px]">
              <thead className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-chalk/40">
                <tr className="border-b border-chalk/10">
                  <th className="py-3 font-normal">Epoch</th>
                  <th className="py-3 text-right font-normal">Verified units</th>
                  <th className="py-3 text-right font-normal">Availability</th>
                  <th className="py-3 text-right font-normal">Multiplier</th>
                  <th className="py-3 text-right font-normal">Quality</th>
                  <th className="py-3 text-right font-normal">Reward</th>
                </tr>
              </thead>
              <tbody className="num">
                {data.epochs.map((e) => (
                  <tr key={e.id} className="border-b border-chalk/[0.06] last:border-0">
                    <td className="py-3.5 font-mono text-[12px] text-chalk/70">
                      {new Date(e.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      <span className="ml-2 text-chalk/35">{new Date(e.startsAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                    </td>
                    <td className="py-3.5 text-right text-chalk/80">{fmtCompact(e.allocation.verifiedCompute, 1)}</td>
                    <td className="py-3.5 text-right text-chalk/80">{Math.round(e.allocation.availability * 100)}%</td>
                    <td className="py-3.5 text-right text-chalk/80">{e.allocation.multiplier ? `${e.allocation.multiplier.toFixed(2)}×` : "—"}</td>
                    <td className="py-3.5 text-right text-chalk/80">{e.allocation.quality ? e.allocation.quality.toFixed(2) : "—"}</td>
                    <td className="py-3.5 text-right">
                      <span className="inline-flex items-center gap-2 font-medium text-chalk">
                        {fmtSol(e.allocation.lamports)} {e.provenance !== "live" && <Prov p="simulated" />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.claims.length > 0 && (
        <div className="rounded-[28px] border border-chalk/10 bg-ink-2 p-7 md:p-9">
          <div className="label text-chalk/50">Claims</div>
          <ul className="mt-5 divide-y divide-chalk/[0.06]">
            {data.claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5 text-[13.5px]">
                <span className="font-mono text-[12px] text-chalk/55">{new Date(c.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
                <span className="num font-medium">{fmtSol(c.lamports)}</span>
                <span className={cx("font-mono text-[11px] uppercase tracking-wide", c.status === "confirmed" ? "text-ok" : c.status === "failed" ? "text-signal" : "text-chalk/60")}>{c.status}</span>
                {c.txSignature ? (
                  <a href={txUrl(c.txSignature, data.payouts.cluster)} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-chalk/60 hover:text-signal">
                    {c.txSignature.slice(0, 8)}… ↗
                  </a>
                ) : (
                  <span className="font-mono text-[12px] text-chalk/30">—</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="px-1 pt-2 text-[12.5px] leading-relaxed text-chalk/40">
        Each epoch settles once: the pool is split across wallets by verified compute, token multiplier and quality, as described{" "}
        <Link href="#formula" className="text-chalk/60 underline-offset-2 hover:underline">
          below
        </Link>
        . Only work verified by the server counts. Claims pay SOL to the wallet that signs them, from the protocol payout wallet.
      </p>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-chalk/40">{k}</dt>
      <dd className="num mt-1.5 text-[20px] font-medium text-chalk">{v}</dd>
    </div>
  );
}

function ConnectPrompt() {
  return (
    <div className="relative overflow-hidden rounded-[28px] border border-chalk/10 bg-ink-2 px-7 py-16 text-center md:py-24">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal/[0.1] blur-[100px]" />
      <div className="relative">
        <div className="label text-chalk/50">Wallet required</div>
        <h2 className="display-md mx-auto mt-4 max-w-[560px] text-[34px] leading-[1.02] md:text-[48px]">Connect the wallet you contribute with.</h2>
        <p className="mx-auto mt-4 max-w-[440px] text-[15px] leading-relaxed text-chalk/55">
          Rewards accrue to the wallet linked to your node. Connecting is read-only; claiming asks you to sign a message.
        </p>
        <div className="mt-8 flex justify-center">
          <WalletButton dark className="h-12 px-6 text-[15px]" />
        </div>
      </div>
    </div>
  );
}

function Skeleton({ error }: { error: boolean }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
      {[0, 1].map((i) => (
        <div key={i} className="h-[340px] animate-pulse rounded-[28px] border border-chalk/10 bg-ink-2">
          {error && i === 0 && <p className="p-9 text-[14px] text-chalk/50">Could not load rewards. Retrying…</p>}
        </div>
      ))}
    </div>
  );
}
