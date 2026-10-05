import type { Metadata } from "next";
import { AutoConsole } from "@/components/economy/AutoConsole";
import { PageHead, Shell, SourceBadge } from "@/components/economy/parts";

export const metadata: Metadata = { title: "BRAIN AUTO", description: "One request. The cheapest valid execution path, chosen from measured estimates." };

export default function AutoPage() {
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            BRAIN AUTO <SourceBadge source="REAL" />
          </>
        }
        title={
          <>
            One request.
            <br />
            <span className="text-chalk/40">The cheapest intelligence available.</span>
          </>
        }
      >
        Anyone can provide compute. Anyone can buy it. BRAIN estimates every execution target from measured latency and configured prices, picks the cheapest valid one for your priority, executes, verifies where it can, and issues a permanent receipt.
      </PageHead>
      <AutoConsole />
    </Shell>
  );
}
