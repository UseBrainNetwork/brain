"use client";

import { AnimatePresence, motion } from "motion/react";
import { useNetwork } from "@/network/realtime/store";
import { cx } from "@/lib/format";

export function EventFeed({ limit = 12, className }: { limit?: number; className?: string }) {
  const feed = useNetwork((s) => s.feed);
  const items = feed.slice(0, limit);
  return (
    <div className={cx("font-mono text-[11px] leading-none", className)}>
      <ul className="relative">
        <AnimatePresence initial={false}>
          {items.map((f) => (
            <motion.li
              key={f.key}
              layout="position"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
              className={cx(
                "grid grid-cols-[1fr_auto] items-center gap-3 border-b border-chalk/[0.06] py-[9px]",
                f.you && "-mx-2 rounded bg-signal/15 px-2",
              )}
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                <span
                  className={cx(
                    "size-[5px] shrink-0 rounded-full",
                    f.you ? "bg-signal" : f.verb === "LEFT" ? "bg-fog-2" : f.verb === "VERIFIED" ? "bg-ok" : f.live ? "bg-ok" : "bg-chalk/40",
                  )}
                />
                <span className={cx("truncate", f.you ? "text-chalk" : "text-chalk/80")}>{f.subject}</span>
                <span className={cx(f.you ? "text-signal" : "text-chalk/40")}>{f.verb}</span>
                {f.live && !f.you && <span className="text-ok">LIVE</span>}
              </span>
              <span className={cx("text-right tabular-nums", f.you ? "text-signal" : f.verb === "LEFT" ? "text-fog-2" : "text-chalk/60")}>{f.value}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
