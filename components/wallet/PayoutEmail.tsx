"use client";

import { useState } from "react";
import { useWallet, walletStore } from "@/lib/wallet/store";
import { cx } from "@/lib/format";

/**
 * One line: payout-email preference for the linked wallet. Shows nothing until the wallet is linked
 * and the preference is known. Hidden entirely when the server has no email provider configured.
 */
export function PayoutEmail({ className, dark }: { className?: string; dark?: boolean }) {
  const w = useWallet();
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (w.status !== "connected" || !w.verified || !w.notify || !w.notify.configured) return null;
  const n = w.notify;
  const base = cx("font-mono text-[11px] leading-relaxed", dark ? "text-chalk/55" : "text-chalk/45", className);
  const link = cx("underline-offset-2 hover:underline", dark ? "text-chalk/80 hover:text-chalk" : "text-chalk/70 hover:text-chalk");

  const save = async (email: string | null) => {
    setBusy(true);
    setErr(null);
    const e = await walletStore.setPayoutEmail(email);
    setBusy(false);
    if (e) return setErr(e);
    setEdit(false);
    setValue("");
  };

  if (edit) {
    return (
      <form
        className={cx(base, "flex flex-wrap items-center gap-2")}
        onSubmit={(ev) => {
          ev.preventDefault();
          void save(value);
        }}
      >
        <input
          type="email"
          required
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="you@example.com"
          className="h-7 w-[200px] rounded-[6px] border border-chalk/15 bg-transparent px-2 font-mono text-[11px] text-chalk outline-none placeholder:text-chalk/30 focus:border-chalk/40"
        />
        <button type="submit" disabled={busy} className="rounded-full bg-chalk px-3 py-1 font-sans text-[11.5px] font-semibold text-ink hover:bg-white disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setEdit(false)} className={link}>
          cancel
        </button>
        {err && <span className="text-warn">{err}</span>}
      </form>
    );
  }
  return (
    <div className={base}>
      {n.on ? (
        <>
          Payout emails to <span className={dark ? "text-chalk/85" : "text-chalk/75"}>{n.email}</span> when an epoch pays this wallet ·{" "}
          <button type="button" onClick={() => setEdit(true)} className={link}>
            change
          </button>{" "}
          ·{" "}
          <button type="button" disabled={busy} onClick={() => void save(null)} className={link}>
            turn off
          </button>
        </>
      ) : (
        <>
          No payout emails ·{" "}
          <button type="button" onClick={() => setEdit(true)} className={link}>
            get an email when an epoch pays this wallet
          </button>
        </>
      )}
      {err && <span className="ml-2 text-warn">{err}</span>}
    </div>
  );
}
