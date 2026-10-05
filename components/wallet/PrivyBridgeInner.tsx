"use client";

import { PrivyProvider, useConnectWallet, useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignMessage, useWallets } from "@privy-io/react-auth/solana";
import { useEffect, useRef } from "react";
import type { WalletAdapter } from "@/lib/wallet/adapters";
import { PRIVY_ADAPTER_ID, PRIVY_APP_ID } from "@/lib/wallet/privy";
import { walletStore } from "@/lib/wallet/store";

/**
 * Mounts Privy and registers it as the primary wallet adapter.
 *
 * Privy only supplies login + message signing. Ownership is still proven the same way as before:
 * server nonce → wallet signature → `/api/wallet/verify` (ed25519 check, holdings, node link).
 * Nothing about rewards trusts Privy's session; the server trusts the signature.
 */
export default function PrivyBridgeInner() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#3d5afe",
          showWalletLoginFirst: true,
          walletChainType: "solana-only",
          walletList: ["detected_solana_wallets", "phantom", "solflare", "backpack", "jupiter", "wallet_connect_qr_solana"],
        },
        loginMethods: ["wallet", "email"],
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        // Email users get a Solana wallet they can sign with; wallet users keep their own.
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, ethereum: { createOnLogin: "off" } },
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}

type Waiter = { resolve: (address: string) => void; reject: (e: Error) => void };

function Bridge() {
  const { authenticated, ready } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { logout } = useLogout();
  const waiters = useRef<Waiter[]>([]);
  const settle = (fn: (w: Waiter) => void) => {
    const ws = waiters.current;
    waiters.current = [];
    ws.forEach(fn);
  };
  // Login finished but no Solana wallet surfaced (e.g. an EVM-only wallet): fail instead of hanging.
  const noSolana = () => {
    setTimeout(() => settle((w) => w.reject(new Error("No Solana wallet connected. Use Phantom, Solflare, Backpack or email."))), 8_000);
  };
  const { login } = useLogin({ onComplete: noSolana, onError: (err) => settle((w) => w.reject(new Error(String(err)))) });
  const { connectWallet } = useConnectWallet({ onSuccess: noSolana, onError: (err) => settle((w) => w.reject(new Error(String(err)))) });

  // Hooks are re-created every render; the adapter is registered once and reads the latest through this ref.
  const latest = useRef({ authenticated, ready, wallets, signMessage, logout, login, connectWallet });
  latest.current = { authenticated, ready, wallets, signMessage, logout, login, connectWallet };

  useEffect(() => {
    const w = wallets[0];
    if (w) settle((x) => x.resolve(w.address));
  }, [wallets]);

  useEffect(() => {
    const adapter: WalletAdapter = {
      id: PRIVY_ADAPTER_ID,
      name: "Privy",
      kind: "privy",
      installed: () => true,
      async connect() {
        const L = latest.current;
        const existing = L.wallets[0];
        if (existing) return existing.address;
        const pending = new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => {
            waiters.current = waiters.current.filter((x) => x !== waiter);
            reject(new Error("Timed out waiting for the wallet."));
          }, 180_000);
          const waiter: Waiter = {
            resolve: (a) => {
              clearTimeout(t);
              resolve(a);
            },
            reject: (e) => {
              clearTimeout(t);
              reject(e);
            },
          };
          waiters.current.push(waiter);
        });
        if (L.authenticated) L.connectWallet({ walletChainType: "solana-only" });
        else L.login({ walletChainType: "solana-only" });
        return pending;
      },
      async signMessage(message) {
        const L = latest.current;
        const current = walletStore.getSnapshot().address;
        const wallet = L.wallets.find((x) => x.address === current) ?? L.wallets[0];
        if (!wallet) throw new Error("No Solana wallet connected.");
        const { signature } = await L.signMessage({
          message,
          wallet,
          options: { uiOptions: { title: "Prove wallet ownership", description: "Signing links this wallet to your BRAIN rewards. It moves no funds." } },
        });
        return signature;
      },
      async disconnect() {
        await latest.current.logout();
      },
    };
    walletStore.registerAdapter(adapter, { primary: true });
    return () => walletStore.unregisterAdapter(adapter.id);
  }, []);

  return null;
}
