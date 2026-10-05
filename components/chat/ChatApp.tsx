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
/** Error codes from the engine → what the user should read. Codes are safe (no vendor bodies). */
function friendlyError(code: string | undefined): string {
  const c = (code ?? "").toLowerCase();
  if (c.startsWith("upstream 402")) return "The model provider rejected the request: provider balance exhausted (402). This is on BRAIN's side, not yours. Try again in a bit.";
  if (c.startsWith("upstream 401") || c.startsWith("upstream 403")) return "The model provider rejected BRAIN's credentials. This is on BRAIN's side. Try again later.";
  if (c.startsWith("upstream 429")) return "The model provider is rate-limiting right now. Wait a few seconds and retry.";
  if (c.startsWith("upstream 404") || c.startsWith("upstream 400")) return "The model provider refused this request shape. Retry; if it persists, try another mode.";
  if (c.startsWith("upstream 5")) return "The model provider returned an error. Retry; BRAIN will route to another provider if one is available.";
  if (c === "timeout") return "The model did not start answering within 45 s. Retry.";
  if (c === "unreachable") return "Could not reach the model provider. Retry.";
  if (c === "no_provider_available" || c.includes("no provider")) return "No model provider can take this request right now.";
  if (c === "internal") return "BRAIN hit an internal error while recording this request. The model may still have answered; retry if not.";
  if (c === "out_of_credits") return "Out of credits for this month.";
  if (c === "connection lost.") return "Connection lost mid-stream. Retry.";
  return code || "Execution failed.";
}

interface ModelMap {
  configured: boolean;
  models: Partial<Record<Mode, string | null>>;
  filters: "none";
}

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
  const [accountErr, setAccountErr] = useState(false);
  const [models, setModels] = useState<ModelMap | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
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
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 12_000);
    fetch("/api/account", { signal: ac.signal })
      .then((r) => r.json())
      .then((j) => {
        setAccount(j.summary ?? null);
        setAccountErr(!j.summary);
      })
      .catch(() => setAccountErr(true))
      .finally(() => clearTimeout(t));
  }, []);
  useEffect(refreshAccount, [refreshAccount]);
  useEffect(() => {
    fetch("/api/chat/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ModelMap | null) => j && setModels(j))
      .catch(() => {});
  }, []);

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
    async (text: string, opts: { dropIds?: string[] } = {}) => {
      const prompt = text.trim();
      if (!prompt || busy) return;
      const drop = new Set(opts.dropIds ?? []);
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
      const history = (convs.find((c) => c.id === convId)?.messages ?? []).filter((m) => !m.error && m.content && !drop.has(m.id)).slice(-20);
      const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: prompt }];

      setBusy("routing");
      const ac = new AbortController();
      abortRef.current = ac;
      const id = convId;
      const patch = (fn: (m: Msg) => Msg) => update(id, (c) => ({ ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === asstMsg.id ? fn(m) : m)) }));
      try {
        const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "brain/auto", messages, mode, privacy, max_tokens: 4096 }), signal: ac.signal });
        if (!r.ok || !r.body) {
          const j = await r.json().catch(() => ({}));
          const msg = friendlyError(j?.error?.code ?? j?.error?.message ?? (r.status === 402 ? "out_of_credits" : `Request failed (${r.status}).`));
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
            const j = JSON.parse(ev.data) as { error?: { code?: string; message?: string }; brain?: BrainRunSummary };
            patch((m) => ({ ...m, streaming: false, error: friendlyError(j.error?.message ?? j.error?.code), brain: j.brain }));
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
        if ((e as Error).name !== "AbortError") patch((m) => ({ ...m, streaming: false, error: friendlyError("connection lost.") }));
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

  /** Re-asks the user prompt that precedes a failed assistant turn, dropping the failed turn. */
  const retry = useCallback(
    (asstId: string) => {
      if (!active || busy) return;
      const idx = active.messages.findIndex((m) => m.id === asstId);
      const userMsg = idx > 0 ? active.messages[idx - 1] : null;
      if (!userMsg || userMsg.role !== "user") return;
      update(active.id, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== asstId && m.id !== userMsg.id) }));
      // Let the state settle so the resend builds history without the failed pair.
      setTimeout(() => void send(userMsg.content, { dropIds: [asstId, userMsg.id] }), 0);
    },
    [active, busy, send, update],
  );

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
          <AccountCard account={account} error={accountErr} onRetry={refreshAccount} />
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
              {!active || active.messages.length === 0 ? <Empty onPick={(t) => void send(t)} models={models} /> : active.messages.map((m) => <Message key={m.id} m={m} onRetry={m.error && !busy ? () => retry(m.id) : undefined} />)}
            </div>
          </div>

          {/* Composer */}
          <div className="shrink-0 bg-gradient-to-t from-ink via-ink/95 to-transparent">
            <div className="mx-auto w-full max-w-[760px] px-4 pb-5 pt-2 md:px-6">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
                className="rounded-[20px] bg-ink-2 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-chalk/12 transition-shadow focus-within:ring-chalk/30"
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
                  placeholder="Paste code, a tx, an idea. Ask anything."
                  className="max-h-[240px] w-full resize-none bg-transparent px-4 pb-1 pt-4 text-[15.5px] leading-[1.5] text-chalk outline-none placeholder:text-chalk/30"
                />
                <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
                  <div className="flex flex-wrap items-center gap-1 font-mono text-[10.5px] tracking-[0.08em]">
                    {MODES.filter((m) => modeAllowed(m.id)).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        title={models?.models[m.id] ? `${m.hint} · ${models.models[m.id]}` : m.hint}
                        onClick={() => setMode(m.id)}
                        className={cx("rounded-full px-2.5 py-1 transition-colors", mode === m.id ? "bg-chalk/[0.12] text-chalk" : "text-chalk/45 hover:bg-chalk/[0.06] hover:text-chalk")}
                      >
                        {m.label}
                      </button>
                    ))}
                    {privateAllowed && (
                      <>
                        <span className="mx-1 h-3.5 w-px bg-chalk/15" />
                        {(["STANDARD", "PRIVATE"] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            title={p === "STANDARD" ? "Plaintext never goes to untrusted distributed nodes" : "Operator infrastructure only"}
                            onClick={() => setPrivacy(p)}
                            className={cx("rounded-full px-2.5 py-1 transition-colors", privacy === p ? "bg-signal/20 text-signal-2" : "text-chalk/45 hover:bg-chalk/[0.06] hover:text-chalk")}
                          >
                            {p}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="hidden font-mono text-[10.5px] text-chalk/35 sm:inline">
                      {credits == null ? "" : `${Math.max(0, Math.floor(credits)).toLocaleString("en-US")} credits`}
                      {planName ? ` · ${planName}` : ""}
                    </span>
                    {busy ? (
                      <button type="button" onClick={stop} aria-label="Stop" className="grid size-9 place-items-center rounded-full bg-chalk/10 text-chalk hover:bg-chalk/15">
                        <span className="block size-3 rounded-[2px] bg-chalk" />
                      </button>
                    ) : (
                      <button type="submit" disabled={!input.trim()} aria-label="Send" className="grid size-9 place-items-center rounded-full bg-chalk text-ink transition-colors hover:bg-white disabled:bg-chalk/15 disabled:text-chalk/40">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <div className="mt-2.5 flex items-center justify-center gap-1.5 font-mono text-[10px] text-chalk/30">
                <span>No added filters. Every answer tells you where it ran and what it cost.</span>
                <span className="hidden sm:inline">·</span>
                <Link href="/account" className="hidden hover:text-chalk/60 sm:inline">
                  Account
                </Link>
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

const PICKS: { k: string; label: string; t: string }[] = [
  { k: "Solana", label: "Anchor escrow with a 24h deadline, constraints and a test", t: "Write an Anchor escrow program: maker deposits SPL tokens, taker can fill before a 24h deadline, maker can cancel after. Include the account constraints and a test." },
  { k: "Audit", label: "Find every way to drain this Solidity vault, worst first", t: "Review this Solidity vault for ways to drain it, worst first. Quote the line, show the attack, give the fix. I will paste the contract next." },
  { k: "Bots", label: "Solana sniper bot: landing txs, priority fees, Jito, slippage", t: "Design a Solana sniper/limit-order bot: how to get a transaction landed fast (priority fees, Jito bundles, RPC choice), how to size slippage, and what gets people rekt." },
  { k: "DeFi", label: "Impermanent loss with real numbers, ETH 2x, fees included", t: "Explain impermanent loss with real numbers: $10k into a 50/50 ETH/USDC pool, ETH doubles. Compare to holding, then add 0.3% fees at $50k daily volume on $2M TVL." },
  { k: "EVM", label: "Foundry fuzz test for ERC-20 permit, expiry and replay", t: "Foundry test for an ERC-20 with permit: fuzz the permit flow, test deadline expiry and signature replay." },
  { k: "Script", label: "Stream a wallet's SPL transfers live with @solana/web3.js", t: "TypeScript with @solana/web3.js: stream all SPL token transfers in and out of a wallet in real time and print them as a table." },
];

function Empty({ onPick, models }: { onPick: (t: string) => void; models: ModelMap | null }) {
  const auto = models?.models.AUTO ?? null;
  const quality = models?.models.QUALITY ?? null;
  return (
    <div className="flex flex-col items-center pt-4 text-center sm:pt-6">
      <CellField />
      <h1 className="display mt-6 text-[36px] leading-[1.0] text-chalk sm:mt-7 sm:text-[52px]">
        Built for <span className="text-chalk/35">builders.</span>
      </h1>
      <p className="mt-5 max-w-[500px] text-[14.5px] leading-relaxed text-chalk/55">
        Code, contracts, protocols, markets. Open-weights models with no filter layer added by BRAIN: it answers the question you asked. Every answer carries a receipt showing where it ran and what it cost.
      </p>
      {models && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-chalk/40">
          {auto ? (
            <span>
              AUTO <span className="text-chalk/70">{auto}</span>
            </span>
          ) : (
            <span className="text-warn">No model provider configured</span>
          )}
          {quality && quality !== auto && (
            <>
              <span className="text-chalk/20">·</span>
              <span>
                QUALITY <span className="text-chalk/70">{quality}</span>
              </span>
            </>
          )}
        </div>
      )}
      <div className="mt-7 grid w-full max-w-[680px] gap-2 sm:grid-cols-2">
        {PICKS.map((p) => (
          <button
            key={p.t}
            type="button"
            onClick={() => onPick(p.t)}
            className="group flex items-start gap-3 rounded-[12px] border border-chalk/10 bg-chalk/[0.02] px-4 py-3 text-left transition-colors hover:border-chalk/25 hover:bg-chalk/[0.045]"
          >
            <span className="mt-[3px] shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-chalk/35 group-hover:text-signal-2">{p.k}</span>
            <span className="flex-1 text-[13.5px] leading-snug text-chalk/75 group-hover:text-chalk">{p.label}</span>
            <span className="mt-[2px] shrink-0 text-chalk/0 transition-colors group-hover:text-chalk/60">→</span>
          </button>
        ))}
      </div>
      <p className="mt-6 max-w-[560px] font-mono text-[10.5px] leading-relaxed text-chalk/30">
        No live market data: it will not quote you a price, and it will tell you how to fetch one. Answers run on an external model provider; each one also sends a verification workload to browser GPU nodes, which the receipt shows.
      </p>
    </div>
  );
}

/** Decorative cell field in the brand's grid motif. Carries no data; purely visual. */
function CellField() {
  const cols = 28;
  const rows = 5;
  const [lit, setLit] = useState<Record<number, 1 | 2>>({});
  useEffect(() => {
    const total = cols * rows;
    const tick = () => {
      const next: Record<number, 1 | 2> = {};
      for (let i = 0; i < 14; i++) next[Math.floor(Math.random() * total)] = Math.random() < 0.3 ? 2 : 1;
      setLit(next);
    };
    tick();
    const id = setInterval(tick, 900);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, 8px)` }} aria-hidden>
      {Array.from({ length: cols * rows }, (_, i) => (
        <span key={i} className={cx("block size-2 rounded-[1.5px] transition-colors duration-700", lit[i] === 2 ? "bg-signal" : lit[i] === 1 ? "bg-chalk/55" : "bg-chalk/[0.07]")} />
      ))}
    </div>
  );
}

function Message({ m, onRetry }: { m: Msg; onRetry?: () => void }) {
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
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[10px] border border-signal/30 bg-signal/[0.06] px-4 py-3 font-mono text-[12px] text-chalk/80">
          <span>
            <span className="text-signal">BRAIN could not complete this request.</span> {m.error}
          </span>
          {onRetry && (
            <button type="button" onClick={onRetry} className="rounded-full bg-chalk px-3 py-1 font-sans text-[12px] font-semibold text-ink hover:bg-white">
              Retry
            </button>
          )}
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
              {b.attached !== undefined && (
                <div className="mt-4 rounded-[10px] border border-chalk/10 bg-chalk/[0.03] px-3.5 py-3 text-[12px] leading-relaxed text-chalk/60">
                  <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-chalk/45">
                    <span>Attached compute</span>
                    {b.attached && !b.attached.skipped ? (
                      <Link href={`/explorer/job/${b.attached.jobId}`} className="text-chalk/70 hover:text-chalk">
                        job {b.attached.jobId} →
                      </Link>
                    ) : (
                      <span>none dispatched</span>
                    )}
                  </div>
                  {b.attached && !b.attached.skipped ? (
                    <p className="mt-1.5">
                      {b.attached.workUnits} {b.attached.size} verification unit{b.attached.workUnits === 1 ? "" : "s"} sent to {b.attached.nodes} network node{b.attached.nodes === 1 ? "" : "s"} after this answer completed. Sized by this request; it did not produce the answer above.
                      Verified units pay those nodes from the hourly pool.
                    </p>
                  ) : (
                    <p className="mt-1.5">{b.attached?.skipped === "no_nodes" ? "No network nodes were online to take work for this request." : "No verification work was attached to this request."}</p>
                  )}
                </div>
              )}
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

function AccountCard({ account, error, onRetry }: { account: AccountSummary | null; error: boolean; onRetry: () => void }) {
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
        <div className="font-mono text-[11px] text-chalk/35">
          {error ? (
            <>
              Account unavailable right now ·{" "}
              <button type="button" onClick={onRetry} className="text-chalk/70 hover:text-chalk">
                retry
              </button>
              <div className="mt-1 text-chalk/30">You can still chat.</div>
            </>
          ) : (
            "Connecting account…"
          )}
        </div>
      )}
    </div>
  );
}
