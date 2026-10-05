"use client";

import { useSyncExternalStore } from "react";
import type { TokenHolding } from "@/domain/types";
import { walletAdapters, type WalletAdapter } from "./adapters";
import { PRIVY_ADAPTER_ID, privyEnabled } from "./privy";

export interface WalletState {
  status: "disconnected" | "connecting" | "signing" | "connected" | "error";
  adapterId: string | null;
  address: string | null;
  holding: TokenHolding | null;
  /** True only when ownership was proven by signature and verified server-side. */
  verified: boolean;
  demo: boolean;
  error: string | null;
  /** Adapter that owns the connect UI (Privy once its bridge mounts); null → built-in wallet picker. */
  primaryAdapterId: string | null;
  /** Payout-email preference for the linked wallet; null until known. `email` is masked by the server. */
  notify: { on: boolean; email: string | null; configured: boolean } | null;
}

const initial: WalletState = {
  status: "disconnected",
  adapterId: null,
  address: null,
  holding: null,
  verified: false,
  demo: false,
  error: null,
  primaryAdapterId: null,
  notify: null,
};

class WalletStore {
  private state = initial;
  private listeners = new Set<() => void>();
  /** Adapters registered at runtime (Privy bridge); built-in ones live in `walletAdapters`. */
  private runtime = new Map<string, WalletAdapter>();
  private awaiting = new Map<string, Set<(a: WalletAdapter) => void>>();
  /** Provided by the contributor engine so a verified wallet links to the running node. */
  sessionToken: () => string | null = () => null;
  /** Server-signed proof of the last verified wallet; lets a recovered node re-link without a new signature. */
  linkToken: string | null = null;

  getSnapshot = () => this.state;
  getServerSnapshot = () => initial;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  private set(p: Partial<WalletState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((l) => l());
  }

  adapter(id: string | null): WalletAdapter | null {
    if (!id) return null;
    return this.runtime.get(id) ?? walletAdapters.find((x) => x.id === id) ?? null;
  }

  /** Called by runtime bridges (Privy) once their hooks are live. `primary` makes it own the connect button. */
  registerAdapter(adapter: WalletAdapter, opts: { primary?: boolean } = {}) {
    this.runtime.set(adapter.id, adapter);
    if (opts.primary) this.set({ primaryAdapterId: adapter.id });
    this.awaiting.get(adapter.id)?.forEach((fn) => fn(adapter));
    this.awaiting.delete(adapter.id);
  }

  unregisterAdapter(id: string) {
    this.runtime.delete(id);
    if (this.state.primaryAdapterId === id) this.set({ primaryAdapterId: null });
  }

  /** True when the connect button should hand off to Privy (configured, even if its bridge is still loading). */
  get usesPrivy() {
    return privyEnabled;
  }

  private whenAdapter(id: string, timeoutMs: number): Promise<WalletAdapter> {
    const now = this.adapter(id);
    if (now) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const set = this.awaiting.get(id) ?? new Set();
      const t = setTimeout(() => {
        set.delete(fn);
        reject(new Error("Wallet login is still loading. Try again in a moment."));
      }, timeoutMs);
      const fn = (a: WalletAdapter) => {
        clearTimeout(t);
        resolve(a);
      };
      set.add(fn);
      this.awaiting.set(id, set);
    });
  }

  /** Connects through the primary adapter (Privy), waiting briefly for its bridge if it has not mounted yet. */
  async connectPrimary() {
    if (!privyEnabled) return;
    this.set({ status: "connecting", adapterId: PRIVY_ADAPTER_ID, error: null });
    try {
      const adapter = await this.whenAdapter(PRIVY_ADAPTER_ID, 15_000);
      await this.connect(adapter);
    } catch (e) {
      this.set({ status: "error", error: describe(e) });
    }
  }

  async connect(adapter: WalletAdapter) {
    this.set({ status: "connecting", adapterId: adapter.id, error: null });
    try {
      const address = await adapter.connect();
      if (adapter.signMessage) {
        this.set({ status: "signing", address });
        const { message } = await post<{ message: string }>("/api/wallet/nonce", { address });
        const sig = await adapter.signMessage(new TextEncoder().encode(message));
        const signature = btoa(String.fromCharCode(...sig));
        const session = this.sessionToken();
        const res = await post<{ holding: TokenHolding; linkToken: string }>("/api/wallet/verify", { address, message, signature }, session);
        this.linkToken = res.linkToken;
        this.set({ status: "connected", address, holding: res.holding, verified: true, demo: false });
        void this.syncNotify(adapter.email?.() ?? null);
      } else {
        const r = await fetch(`/api/wallet/holdings?address=${encodeURIComponent(address)}`);
        const { holding } = (await r.json()) as { holding: TokenHolding };
        this.set({ status: "connected", address, holding, verified: false, demo: true });
      }
    } catch (e) {
      this.set({ status: "error", address: null, error: describe(e) });
    }
  }

  /** Signs a UTF-8 message with the connected wallet. Demo wallets cannot sign. */
  async sign(message: string): Promise<string> {
    const a = this.adapter(this.state.adapterId);
    if (!a?.signMessage || !this.state.verified) throw new Error("This wallet cannot sign");
    const sig = await a.signMessage(new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...sig));
  }

  dismissError() {
    if (this.state.status === "error") this.set({ status: "disconnected", error: null, adapterId: null });
  }

  /**
   * Payout-email preference. After a verified link: if the login provider knows an email (Privy email
   * login) and the wallet has no preference yet, enroll it; otherwise just read the current state.
   * Every email carries an unsubscribe link; `setPayoutEmail(null)` turns it off here.
   */
  private async syncNotify(providerEmail: string | null) {
    if (!this.linkToken) return;
    try {
      const cur = await getJson<NotifyShape>(`/api/wallet/email?linkToken=${encodeURIComponent(this.linkToken)}`);
      if (!cur.on && cur.email === null && providerEmail && !cur.optedOut) {
        const n = await post<NotifyShape>("/api/wallet/email", { linkToken: this.linkToken, email: providerEmail, source: "privy" });
        this.set({ notify: { on: n.on, email: n.email, configured: n.configured } });
      } else {
        this.set({ notify: { on: cur.on, email: cur.email, configured: cur.configured } });
      }
    } catch {
      /* notifications are optional; never surface as a wallet error */
    }
  }

  async setPayoutEmail(email: string | null): Promise<string | null> {
    if (!this.linkToken) return "Link a wallet first.";
    try {
      const n = email ? await post<NotifyShape>("/api/wallet/email", { linkToken: this.linkToken, email, source: "manual" }) : await del<NotifyShape>("/api/wallet/email", { linkToken: this.linkToken });
      this.set({ notify: { on: n.on, email: n.email, configured: n.configured } });
      return null;
    } catch (e) {
      const m = e instanceof Error ? e.message : "request_failed";
      return m === "invalid_email" ? "That email does not look right." : m === "bad_link_token" ? "Wallet link expired. Reconnect and try again." : "Could not save. Try again.";
    }
  }

  async disconnect() {
    const a = this.adapter(this.state.adapterId);
    await a?.disconnect().catch(() => {});
    this.linkToken = null;
    this.set({ ...initial, primaryAdapterId: this.state.primaryAdapterId });
  }
}

/** Human-readable connect/sign failure. Never leaks internals; wallets and Privy throw a variety of shapes. */
function describe(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : (e as { message?: unknown })?.message;
  const m = typeof raw === "string" ? raw : "";
  const l = m.toLowerCase();
  if (l.includes("reject") || l.includes("declined") || l.includes("denied") || l.includes("cancel")) return "Signature declined in your wallet. Nothing was linked.";
  if (l.includes("exited") || l.includes("closed")) return "Login closed before a wallet was connected.";
  if (l === "rate_limited" || l.includes("too many")) return "Too many attempts. Wait a minute and try again.";
  if (l === "bad_signature") return "That signature did not match the wallet. Try again.";
  if (l === "request_failed" || l.includes("fetch") || l.includes("network")) return "Could not reach the server. Try again.";
  if (l.includes("timed out") || l.includes("timeout")) return "Timed out waiting for the wallet. Try again.";
  return m || "Connection failed. Try again.";
}

interface NotifyShape {
  on: boolean;
  email: string | null;
  configured: boolean;
  optedOut: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "request_failed");
  return j as T;
}

async function del<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "request_failed");
  return j as T;
}

async function post<T>(url: string, body: unknown, bearer?: string | null): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : "request_failed");
  return j as T;
}

const g = globalThis as typeof globalThis & { __brainWallet?: WalletStore };
export const walletStore = (g.__brainWallet ??= new WalletStore());

export function useWallet(): WalletState {
  return useSyncExternalStore(walletStore.subscribe, walletStore.getSnapshot, walletStore.getServerSnapshot);
}
