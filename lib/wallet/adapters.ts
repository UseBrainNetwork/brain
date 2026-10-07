"use client";

/**
 * Minimal Solana wallet adapter abstraction. Injected providers share one implementation;
 * add Wallet Standard / mobile adapters by implementing WalletAdapter.
 */

export interface WalletAdapter {
  id: string;
  name: string;
  /** `privy` adapters are registered at runtime by the Privy bridge and own the login UI. */
  kind: "injected" | "demo" | "privy";
  installed(): boolean;
  installUrl?: string;
  connect(): Promise<string>;
  /** null when the adapter cannot sign (demo). */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /**
   * Sign and broadcast a serialized, unsigned transaction built by the server (plan purchases).
   * Resolves to the base58 signature. Absent when the adapter cannot send transactions.
   */
  signAndSendTransaction?: (transaction: Uint8Array) => Promise<string>;
  disconnect(): Promise<void>;
  /** Email the login provider knows for this user (Privy email login), used for payout notifications. */
  email?: () => string | null;
}

interface InjectedProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  /** Phantom, Solflare and Backpack all accept a web3.js Transaction and return the signature. */
  signAndSendTransaction?(transaction: unknown, options?: unknown): Promise<{ signature: string }>;
  publicKey?: { toString(): string } | null;
}

type W = Window & {
  phantom?: { solana?: InjectedProvider & { isPhantom?: boolean } };
  solflare?: InjectedProvider & { isSolflare?: boolean };
  backpack?: InjectedProvider;
};

function injected(id: string, name: string, get: () => InjectedProvider | undefined, installUrl: string): WalletAdapter {
  return {
    id,
    name,
    kind: "injected",
    installUrl,
    installed: () => typeof window !== "undefined" && Boolean(get()),
    async connect() {
      const p = get();
      if (!p) throw new Error(`${name} not installed`);
      const res = await p.connect();
      return (res?.publicKey ?? p.publicKey)!.toString();
    },
    signMessage: async (message) => {
      const p = get();
      if (!p) throw new Error(`${name} not installed`);
      const out = await p.signMessage(message, "utf8");
      return out instanceof Uint8Array ? out : out.signature;
    },
    signAndSendTransaction: async (bytes) => {
      const p = get();
      if (!p?.signAndSendTransaction) throw new Error(`${name} cannot send transactions`);
      // web3.js is loaded only here; the rest of the wallet layer has no need for it.
      const { Transaction } = await import("@solana/web3.js");
      const { signature } = await p.signAndSendTransaction(Transaction.from(bytes));
      return signature;
    },
    async disconnect() {
      await get()?.disconnect().catch(() => {});
    },
  };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** DEMO wallet: random throwaway address, cannot sign, never linked to a node. */
export const demoAdapter: WalletAdapter = {
  id: "demo",
  name: "Demo wallet",
  kind: "demo",
  installed: () => true,
  async connect() {
    const key = "brain.demoWallet";
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const addr = base58Encode(crypto.getRandomValues(new Uint8Array(32)));
    sessionStorage.setItem(key, addr);
    return addr;
  },
  signMessage: null,
  async disconnect() {},
};

export const walletAdapters: WalletAdapter[] = [
  injected("phantom", "Phantom", () => (window as W).phantom?.solana, "https://phantom.app/download"),
  injected("solflare", "Solflare", () => (window as W).solflare, "https://solflare.com/download"),
  injected("backpack", "Backpack", () => (window as W).backpack, "https://backpack.app/download"),
  demoAdapter,
];
