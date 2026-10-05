"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Full-screen operational pages (recorded demos, node screens) render without site chrome. */
const BARE = [/^\/demo(\/|$)/, /^\/node$/];

export function Chrome({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  if (BARE.some((re) => re.test(path))) return null;
  return <>{children}</>;
}
