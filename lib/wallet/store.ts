"use client";

import { useSyncExternalStore } from "react";
import type { TokenHolding } from "@/domain/types";
import { walletAdapters, type WalletAdapter } from "./adapters";

export interface WalletState {
  status: "disconnected" | "connecting" | "signing" | "connected" | "error";
  adapterId: string | null;
  address: string | null;
  holding: TokenHolding | null;
  /** True only when ownership was proven by signature and verified server-side. */
  verified: boolean;
  demo: boolean;
  error: string | null;
}

const initial: WalletState = { status: "disconnected", adapterId: null, address: null, holding: null, verified: false, demo: false, error: null };

class WalletStore {
  private state = initial;
  private listeners = new Set<() => void>();
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
      } else {
        const r = await fetch(`/api/wallet/holdings?address=${encodeURIComponent(address)}`);
        const { holding } = (await r.json()) as { holding: TokenHolding };
        this.set({ status: "connected", address, holding, verified: false, demo: true });
      }
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : "Connection failed" });
    }
  }

  /** Signs a UTF-8 message with the connected wallet. Demo wallets cannot sign. */
  async sign(message: string): Promise<string> {
    const a = walletAdapters.find((x) => x.id === this.state.adapterId);
    if (!a?.signMessage || !this.state.verified) throw new Error("This wallet cannot sign");
    const sig = await a.signMessage(new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...sig));
  }

  async disconnect() {
    const a = walletAdapters.find((x) => x.id === this.state.adapterId);
    await a?.disconnect();
    this.linkToken = null;
    this.set(initial);
  }
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
