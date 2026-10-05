"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Prov } from "@/components/ui";
import { walletAdapters } from "@/lib/wallet/adapters";
import { useWallet, walletStore } from "@/lib/wallet/store";
import { useSim } from "@/network/realtime/mode";
import { cx, fmtInt, shortAddr } from "@/lib/format";

export function WalletButton({ dark, className }: { dark?: boolean; className?: string }) {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const connected = w.status === "connected" && w.address;
  const busy = w.status === "connecting" || w.status === "signing";
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const start = () => {
    if (connected) return setMenu((m) => !m);
    if (busy) return;
    if (walletStore.usesPrivy) void walletStore.connectPrimary();
    else setOpen(true);
  };

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={start}
        disabled={busy}
        aria-expanded={connected ? menu : undefined}
        className={cx(
          "group inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13.5px] font-semibold transition-colors duration-300",
          dark ? "bg-chalk text-ink hover:bg-white" : "bg-ink text-chalk hover:bg-ink-3",
          className,
        )}
      >
        {connected ? (
          <>
            <span className={cx("size-[6px]", w.demo ? "bg-fog" : "bg-ok")} />
            <span className="font-mono text-[12.5px]">{shortAddr(w.address!)}</span>
          </>
        ) : busy ? (
          <span>{w.status === "signing" ? "Sign in wallet…" : "Connecting…"}</span>
        ) : w.status === "error" ? (
          <>
            Try again <span className="transition-transform group-hover:translate-x-0.5">↻</span>
          </>
        ) : (
          <>
            Connect wallet <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </>
        )}
      </button>
      {connected && menu && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-2xl border border-chalk/10 bg-ink-2 p-1.5 text-[14px] text-chalk shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
          <Link href="/rewards" onClick={() => setMenu(false)} className="flex items-center justify-between rounded-xl px-3.5 py-2.5 hover:bg-chalk/[0.06]">
            My rewards <span className="text-signal">→</span>
          </Link>
          <button
            onClick={() => {
              setMenu(false);
              walletStore.disconnect();
            }}
            className="w-full rounded-xl px-3.5 py-2.5 text-left text-chalk/60 hover:bg-chalk/[0.06] hover:text-chalk"
          >
            Disconnect
          </button>
        </div>
      )}
      {w.status === "error" && w.error && !open && (
        <div
          role="alert"
          className={cx(
            "absolute right-0 top-full z-50 mt-2 w-[280px] rounded-2xl p-3 text-left text-[12.5px] leading-snug shadow-[0_20px_60px_rgba(0,0,0,0.45)]",
            dark ? "border border-chalk/10 bg-ink-2 text-chalk/80" : "border border-ink/10 bg-paper text-ink/80",
          )}
        >
          <div className="label mb-1 text-signal">Wallet not connected</div>
          {w.error}
          <button onClick={() => walletStore.dismissError()} className="mt-2 block font-mono text-[11px] uppercase tracking-[0.08em] opacity-50 hover:opacity-100">
            dismiss
          </button>
        </div>
      )}
      {open && <WalletModal onClose={() => setOpen(false)} />}
    </div>
  );
}

export function WalletModal({ onClose }: { onClose: () => void }) {
  const sim = useSim();
  const w = useWallet();
  const privy = walletStore.usesPrivy;
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (privy) return;
    setInstalled(Object.fromEntries(walletAdapters.map((a) => [a.id, a.installed()])));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, privy]);
  useEffect(() => {
    if (w.status === "connected") onClose();
  }, [w.status, onClose]);
  // With Privy configured, Privy's own modal is the picker: hand off and close ours.
  useEffect(() => {
    if (!privy) return;
    if (w.status === "disconnected" || w.status === "error") void walletStore.connectPrimary();
    onClose();
  }, [privy, w.status, onClose]);
  if (privy) return null;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-ink/50 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Connect a Solana wallet"
        className="w-full max-w-[400px] rounded-[22px] bg-paper p-2 text-ink shadow-[0_30px_80px_-20px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <div className="text-[17px] font-semibold">Connect wallet</div>
          <button onClick={onClose} className="label opacity-50 hover:opacity-100">
            esc
          </button>
        </div>
        <p className="px-4 pb-3 text-[13px] leading-snug text-fog-2">
          Holdings raise your reward weighting only while you run verified compute. Signing a message proves ownership; it moves no funds.
        </p>
        <div className="space-y-1">
          {walletAdapters.filter((a) => a.kind !== "demo" || sim).map((a) => {
            const ok = installed[a.id];
            return (
              <button
                key={a.id}
                onClick={() => (ok ? walletStore.connect(a) : a.installUrl && window.open(a.installUrl, "_blank", "noopener"))}
                className="flex w-full items-center justify-between rounded-2xl px-4 py-3.5 text-left transition-colors hover:bg-ink/[0.05]"
              >
                <span className="flex items-center gap-3">
                  <span className={cx("grid size-8 place-items-center rounded-lg font-mono text-[12px] font-semibold", a.kind === "demo" ? "bg-bone-2 text-fog-2" : "bg-ink text-chalk")}>
                    {a.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <span className="block text-[15px] font-medium">{a.name}</span>
                    {a.kind === "demo" && <span className="block text-[12px] text-fog-2">Throwaway address · demo holdings · cannot link to payouts</span>}
                  </span>
                </span>
                <span className="label opacity-60">{a.kind === "demo" ? <Prov p="simulated" /> : ok ? "detected" : "install ↗"}</span>
              </button>
            );
          })}
        </div>
        {w.status === "error" && <div className="mx-4 my-2 rounded-lg bg-signal/10 px-3 py-2 font-mono text-[12px] text-signal">{w.error}</div>}
        {w.holding && (
          <div className="px-4 py-2 font-mono text-[12px] text-fog-2">
            {fmtInt(w.holding.amount)} BRAIN <Prov p={w.holding.provenance} />
          </div>
        )}
      </div>
    </div>
  );
}
