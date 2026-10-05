"use client";

import dynamic from "next/dynamic";
import { privyEnabled } from "@/lib/wallet/privy";

/** Client-only; Privy's SDK is large and touches `window`, so it never renders on the server. */
const Inner = dynamic(() => import("./PrivyBridgeInner"), { ssr: false });

export function PrivyBridge() {
  if (!privyEnabled) return null;
  return <Inner />;
}
