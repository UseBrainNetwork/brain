"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrainRunSummary } from "@/api/chatStream";
import type { PrivacyRequirement, RoutingMode } from "@/domain/economy";
import { cx } from "@/lib/format";
import type { AccountSummary } from "@/services/accountSummary";
import { usd } from "@/components/economy/parts";
import { renderMarkdown } from "./markdown";

/* ----------------------------------------------------------------- model */

type Role = "user" | "assistant";
interface Msg {
  id: string;
  role: Role;
  content: string;
  /** Assistant only. */
  brain?: BrainRunSummary;
  error?: string;
  streaming?: boolean;
}
interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
}

type Mode = Exclude<RoutingMode, "BROWSER_ONLY">;
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "AUTO", label: "AUTO", hint: "Best balance of cost, latency and reliability" },
  { id: "CHEAP", label: "CHEAP", hint: "Lowest cost that meets the request" },
  { id: "FAST", label: "FAST", hint: "Lowest measured latency" },
  { id: "QUALITY", label: "QUALITY", hint: "Highest configured quality tier" },
];
const TARGET_LABEL: Record<string, string> = { BROWSER_NETWORK: "BROWSER COMPUTE", NATIVE_NETWORK: "NATIVE GPU", CLOUD_GPU: "CLOUD GPU", EXTERNAL_MODEL: "EXTERNAL MODEL", EXTERNAL_PROVIDER: "EXTERNAL MODEL" };

const STORAGE = "brain.chat.v1";
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function load(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const j = JSON.parse(localStorage.getItem(STORAGE) ?? "[]") as Conversation[];
    return Array.isArray(j) ? j.map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, streaming: false })) })) : [];
  } catch {
    return [];
  }
}
function persist(cs: Conversation[]) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(cs.slice(0, 50)));
  } catch {
    /* quota */
  }
}

/* ----------------------------------------------------------------- SSE */

async function* sse(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const l of block.split("\n")) {
        if (l.startsWith("event:")) event = l.slice(6).trim();
        else if (l.startsWith("data:")) data.push(l.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

/* ----------------------------------------------------------------- app */

export function ChatApp() {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("AUTO");
  const [privacy, setPrivacy] = useState<PrivacyRequirement>("STANDARD");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<null | "routing" | "streaming">(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const cs = load();
    setConvs(cs);
    setActiveId(cs[0]?.id ?? null);
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (hydrated) persist(convs);
  }, [convs, hydrated]);

  const refreshAccount = useCallback(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((j) => setAccount(j.summary ?? null))
      .catch(() => {});
  }, []);
  useEffect(refreshAccount, [refreshAccount]);

  const active = useMemo(() => convs.find((c) => c.id === activeId) ?? null, [convs, activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [active?.messages, busy]);

  const update = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? fn(c) : c)).sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  const newChat = useCallback(() => {
    setActiveId(null);
    setRailOpen(false);
    taRef.current?.focus();
  }, []);

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      setInput("");
      let convId = activeId;
      const userMsg: Msg = { id: uid(), role: "user", content: prompt };
      const asstMsg: Msg = { id: uid(), role: "assistant", content: "", streaming: true };
      if (!convId) {
        convId = uid();
        const c: Conversation = { id: convId, title: prompt.slice(0, 48), createdAt: Date.now(), updatedAt: Date.now(), messages: [userMsg, asstMsg] };
        setConvs((cs) => [c, ...cs]);
        setActiveId(convId);
      } else {
        update(convId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, userMsg, asstMsg] }));
      }
      const history = (convs.find((c) => c.id === convId)?.messages ?? []).filter((m) => !m.error && m.content).slice(-12);
      const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: prompt }];

      setBusy("routing");
      const ac = new AbortController();
      abortRef.current = ac;
      const id = convId;
      const patch = (fn: (m: Msg) => Msg) => update(id, (c) => ({ ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === asstMsg.id ? fn(m) : m)) }));
      try {
        const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "brain/auto", messages, mode, privacy, max_tokens: 1024 }), signal: ac.signal });
        if (!r.ok || !r.body) {
          const j = await r.json().catch(() => ({}));
          const msg = j?.error?.message ?? (r.status === 402 ? "Out of credits." : `Request failed (${r.status}).`);
          patch((m) => ({ ...m, streaming: false, error: msg }));
          return;
        }
        let acc = "";
        let first = true;
        for await (const ev of sse(r.body)) {
          if (ev.data === "[DONE]") break;
          if (ev.event === "brain") {
            const brain = JSON.parse(ev.data) as BrainRunSummary;
            patch((m) => ({ ...m, brain, streaming: false }));
            continue;
          }
          if (ev.event === "error") {
            const j = JSON.parse(ev.data) as { error?: { message?: string }; brain?: BrainRunSummary };
            patch((m) => ({ ...m, streaming: false, error: j.error?.message ?? "Execution failed.", brain: j.brain }));
            continue;
          }
          try {
            const j = JSON.parse(ev.data) as { choices?: { delta?: { content?: string } }[] };
            const delta = j.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              acc += delta;
              if (first) {
                first = false;
                setBusy("streaming");
              }
              const snapshot = acc;
              patch((m) => ({ ...m, content: snapshot }));
            }
          } catch {
            /* ignore partial */
          }
        }
        patch((m) => ({ ...m, streaming: false }));
      } catch (e) {
        if ((e as Error).name !== "AbortError") patch((m) => ({ ...m, streaming: false, error: "Connection lost." }));
        else patch((m) => ({ ...m, streaming: false }));
      } finally {
        setBusy(null);
        abortRef.current = null;
        refreshAccount();
      }
    },
    [activeId, busy, convs, mode, privacy, refreshAccount, update],
  );

  const stop = () => abortRef.current?.abort();

  const planName = account?.plan.name ?? null;
  const credits = account?.credits.balance ?? null;
  const modeAllowed = (m: Mode) => !account || account.plan.modes.includes(m);
  const privateAllowed = !account || account.plan.privateRouting;

  return (
    <div data-theme="dark" className="surface-dark flex h-dvh flex-col pt-[72px] text-chalk">
      <div className="relative flex min-h-0 flex-1">
        {/* Rail */}
        <aside className={cx("absolute inset-y-0 left-0 z-20 flex w-[280px] flex-col border-r border-chalk/10 bg-ink transition-transform md:static md:translate-x-0", railOpen ? "translate-x-0" : "-translate-x-full")}>
          <div className="flex items-center justify-between px-4 pt-4">
            <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-chalk/45">Conversations</div>
            <button type="button" onClick={newChat} className="rounded-full bg-chalk px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-white">
              New
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {convs.length === 0 && <div className="px-3 py-6 text-[12.5px] leading-relaxed text-chalk/35">Conversations stay in this browser. BRAIN keeps receipts, not your messages.</div>}
            {convs.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setActiveId(c.id);
                  setRailOpen(false);
                }}
                className={cx("group flex w-full items-center justify-between rounded-[8px] px-3 py-2.5 text-left text-[13px]", c.id === activeId ? "bg-chalk/[0.07] text-chalk" : "text-chalk/60 hover:bg-chalk/[0.04] hover:text-chalk")}
              >
                <span className="truncate">{c.title || "Untitled"}</span>
                <span className="ml-2 shrink-0 font-mono text-[10px] text-chalk/30">{c.messages.filter((m) => m.role === "assistant" && m.brain).length}R</span>
              </button>
            ))}
          </div>
          <AccountCard account={account} />
        </aside>
        {railOpen && <button aria-label="Close" onClick={() => setRailOpen(false)} className="absolute inset-0 z-10 bg-ink/60 md:hidden" />}

        {/* Thread */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-chalk/10 px-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-chalk/45">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setRailOpen(true)} className="rounded px-1.5 py-1 hover:bg-chalk/[0.06] md:hidden" aria-label="Conversations">
                ☰
              </button>
              <span className="text-chalk/70">BRAIN</span>
              <span className="hidden sm:inline">·</span>
              <span className="hidden sm:inline">
Route <span className="text-chalk/70">{mode}</span>
              </span>
            </div>
            <StatusLine busy={busy} />
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[760px] px-4 pb-8 pt-6 md:px-6">
              {!active || active.messages.length === 0 ? <Empty onPick={(t) => void send(t)} /> : active.messages.map((m) => <Message key={m.id} m={m} />)}
            </div>
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-chalk/10 bg-ink/80 backdrop-blur">
            <div className="mx-auto w-full max-w-[760px] px-4 pb-4 pt-3 md:px-6">
              <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em]">
                <span className="mr-1 text-chalk/35">ROUTE</span>
                {MODES.filter((m) => modeAllowed(m.id)).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    title={m.hint}
                    onClick={() => setMode(m.id)}
                    className={cx("rounded-full px-2.5 py-1 transition-colors", mode === m.id ? "bg-chalk text-ink" : "text-chalk/55 ring-1 ring-inset ring-chalk/15 hover:text-chalk")}
                  >
                    {m.label}
                  </button>
                ))}
                {privateAllowed && (
                  <>
                    <span className="mx-1 h-4 w-px bg-chalk/15" />
                    {(["STANDARD", "PRIVATE"] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        title={p === "STANDARD" ? "Plaintext never goes to untrusted distributed nodes" : "Operator infrastructure only"}
                        onClick={() => setPrivacy(p)}
                        className={cx("rounded-full px-2.5 py-1 transition-colors", privacy === p ? "bg-signal text-white" : "text-chalk/55 ring-1 ring-inset ring-chalk/15 hover:text-chalk")}
                      >
                        {p}
                      </button>
                    ))}
                  </>
                )}
                <span className="ml-auto hidden text-chalk/35 sm:inline">{credits == null ? "" : `${Math.max(0, Math.floor(credits)).toLocaleString("en-US")} credits`}</span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
                className="flex items-end gap-2 rounded-[14px] bg-ink-2 p-2 ring-1 ring-inset ring-chalk/12 focus-within:ring-chalk/30"
              >
                <textarea
                  ref={taRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value.slice(0, 16_000))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                  rows={Math.min(8, Math.max(1, input.split("\n").length))}
                  placeholder={narrow ? "Ask BRAIN anything." : "Ask BRAIN anything. Every answer tells you where it ran."}
                  className="max-h-[220px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-[1.5] text-chalk outline-none placeholder:text-chalk/30"
                />
                {busy ? (
                  <button type="button" onClick={stop} className="h-10 shrink-0 rounded-[10px] bg-chalk/10 px-4 font-mono text-[11px] uppercase tracking-[0.1em] text-chalk hover:bg-chalk/15">
                    Stop
                  </button>
                ) : (
                  <button type="submit" disabled={!input.trim()} className="h-10 shrink-0 rounded-[10px] bg-signal px-4 text-[13.5px] font-semibold text-white hover:bg-signal-2 disabled:opacity-35">
                    Send
                  </button>
                )}
              </form>
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-chalk/30">
                <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
                <span className="sm:hidden">Conversations stay in this browser</span>
                <span>
                  {planName ? `${planName} plan` : ""} · <Link href="/account" className="hover:text-chalk/60">Account</Link>
                </span>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- pieces */

function StatusLine({ busy }: { busy: null | "routing" | "streaming" }) {
  if (!busy) return <span className="text-chalk/35">READY</span>;
  return (
    <span className="flex items-center gap-2 text-signal">
      <span className="inline-block size-[6px] animate-pulse-dot bg-signal" />
      {busy === "routing" ? "ROUTING" : "STREAMING"}
    </span>
  );
}

function Empty({ onPick }: { onPick: (t: string) => void }) {
  const picks = ["Explain what a compute receipt proves and what it does not.", "Summarise the trade-offs between routing for cost and routing for latency.", "Write a Python function that verifies a sha256 hash of a file.", "What is a verified work unit?"];
  return (
    <div className="flex min-h-[55vh] flex-col items-start justify-end">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-chalk/40">BRAIN</div>
      <h1 className="display mt-3 text-[34px] leading-[1.02] text-chalk sm:text-[46px]">
        Compute
        <br />
        <span className="text-chalk/40">from everywhere.</span>
      </h1>
      <p className="mt-4 max-w-[560px] text-[14px] leading-relaxed text-chalk/55">
        BRAIN AUTO estimates every execution target, picks one for your mode and privacy setting, runs it, and attaches a receipt. Today chat runs on a configured model provider; the browser network runs verified parallel compute. Each answer says exactly which.
      </p>
      <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
        {picks.map((p) => (
          <button key={p} type="button" onClick={() => onPick(p)} className="rounded-[10px] border border-chalk/10 bg-chalk/[0.025] px-4 py-3 text-left text-[13.5px] leading-snug text-chalk/75 hover:border-chalk/25 hover:text-chalk">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  if (m.role === "user") {
    return (
      <div className="my-5 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-chalk/[0.08] px-4 py-3 text-[15px] leading-[1.55] text-chalk">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="my-5">
      <div className="text-[15px] text-chalk/90">
        {m.content ? renderMarkdown(m.content) : null}
        {m.streaming && <span className="ml-0.5 inline-block h-[1em] w-[7px] translate-y-[2px] animate-blink bg-chalk/80 align-baseline" />}
        {!m.content && !m.streaming && !m.error && <span className="text-chalk/40">No content returned.</span>}
      </div>
      {m.error && (
        <div className="mt-3 rounded-[10px] border border-signal/30 bg-signal/[0.06] px-4 py-3 font-mono text-[12px] text-chalk/80">
          <span className="text-signal">BRAIN could not complete this request.</span> {m.error}
        </div>
      )}
      {m.brain && <PoweredBy b={m.brain} />}
    </div>
  );
}

function PoweredBy({ b }: { b: BrainRunSummary }) {
  const [open, setOpen] = useState(false);
  const target = b.target ? (TARGET_LABEL[b.target] ?? b.target) : "NO ROUTE";
  const cost = b.cost ? String(usd(b.cost.amount)) : "UNKNOWN";
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cx("inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors", open ? "border-chalk/30 text-chalk" : "border-chalk/12 text-chalk/55 hover:border-chalk/25 hover:text-chalk")}
      >
        <span className={cx("inline-block size-[6px]", b.verified ? "bg-ok" : b.status === "COMPLETED" ? "bg-signal" : "bg-chalk/40")} />
        Powered by BRAIN
        <span className="hidden text-chalk/35 sm:inline">·</span>
        <span className="hidden truncate sm:inline">{target}</span>
        <span className="hidden text-chalk/35 sm:inline">·</span>
        <span className="hidden sm:inline">{cost}</span>
        <span className="text-chalk/35">{open ? "▴" : "▾"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="mt-2 rounded-[12px] border border-chalk/10 bg-chalk/[0.025] p-4">
              <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-chalk/45">
                <span>How BRAIN ran this</span>
                <span className={cx("rounded-[3px] px-1.5 py-[2px] font-semibold", b.status === "COMPLETED" ? "bg-ok/15 text-ok" : "bg-signal/15 text-signal")}>{b.status}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                <Cell k="Route" v={target} sub={b.provider ?? undefined} />
                <Cell k="Model" v={b.model ?? "UNKNOWN"} />
                <Cell k="Nodes" v={String(b.nodesUsed)} sub={b.nodesUsed === 0 ? "no network nodes in this route" : "verified network nodes"} />
                <Cell k="Cost" v={cost} sub={b.cost ? b.cost.basis : "no configured price"} />
                <Cell k="Latency" v={b.latencyMs >= 1000 ? `${(b.latencyMs / 1000).toFixed(2)}s` : `${b.latencyMs}ms`} sub="end to end, server measured" />
                <Cell k="Verified" v={b.verified ? "YES" : "NO"} sub={b.verification ?? undefined} tone={b.verified ? "ok" : undefined} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[11px]">
                {b.receiptId && (
                  <Link href={`/receipt/${b.receiptId}`} className="rounded-full bg-chalk px-3.5 py-1.5 font-sans text-[12.5px] font-semibold text-ink hover:bg-white">
                    View receipt →
                  </Link>
                )}
                <span className="text-chalk/35">
                  mode {b.mode} · privacy {b.privacy}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Cell({ k, v, sub, tone }: { k: string; v: ReactNode; sub?: string; tone?: "ok" }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-chalk/40">{k}</div>
      <div className={cx("mt-1 truncate font-mono text-[12.5px]", tone === "ok" ? "text-ok" : "text-chalk")} title={typeof v === "string" ? v : undefined}>
        {v}
      </div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-chalk/35" title={sub}>{sub}</div>}
    </div>
  );
}

function AccountCard({ account }: { account: AccountSummary | null }) {
  return (
    <div className="border-t border-chalk/10 p-4">
      {account ? (
        <>
          <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-[0.14em] text-chalk/45">
            <span>{account.plan.name} plan</span>
            <span className="text-ok">REAL</span>
          </div>
          <div className="num mt-2 text-[24px] leading-none text-chalk">{Math.max(0, Math.floor(account.credits.balance)).toLocaleString("en-US")}</div>
          <div className="mt-1 font-mono text-[10.5px] text-chalk/40">credits · 1 credit = {usd(account.credits.creditUsd)}</div>
          {account.compute.wallet ? (
            <div className="mt-3 font-mono text-[10.5px] text-chalk/50">
              Compute earned {account.compute.earnedUsd == null ? "—" : usd(account.compute.earnedUsd)} · {account.compute.nodesOnline} node{account.compute.nodesOnline === 1 ? "" : "s"} online
            </div>
          ) : (
            <Link href="/earn" className="mt-3 block font-mono text-[10.5px] text-chalk/50 hover:text-chalk">
              Power BRAIN with your computer →
            </Link>
          )}
          <div className="mt-3 flex gap-3 font-mono text-[11px]">
            <Link href="/account" className="text-chalk/70 hover:text-chalk">
              Account
            </Link>
            <Link href="/pricing" className="text-chalk/70 hover:text-chalk">
              Plans
            </Link>
          </div>
        </>
      ) : (
        <div className="font-mono text-[11px] text-chalk/35">Connecting account…</div>
      )}
    </div>
  );
}
