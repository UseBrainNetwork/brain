"use client";

import { useState } from "react";

export function CopyLink({ label = "Copy link" }: { label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(window.location.href).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="h-9 rounded-full px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/70 ring-1 ring-inset ring-chalk/20 hover:text-chalk"
    >
      {done ? "Copied" : label}
    </button>
  );
}
