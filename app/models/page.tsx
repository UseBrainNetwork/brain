import type { Metadata } from "next";
import Link from "next/link";
import { PageHead, Shell, SourceBadge } from "@/components/economy/parts";
import { ImportedModels } from "@/components/network/ImportedModels";
import { ModelMarket } from "@/components/network/ModelMarket";

export const metadata: Metadata = { title: "Models", description: "Open-weight models Brain Nodes can serve, including any Hugging Face GGUF you import, with how many nodes have each one online right now." };
export const dynamic = "force-dynamic";

export default function ModelsPage() {
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Model market <SourceBadge source="REAL" />
          </>
        }
        title="Models on Brain Nodes."
        right={
          <div className="flex gap-4 font-mono text-[11px] uppercase tracking-[0.12em] text-chalk/60">
            <Link href="/network" className="hover:text-chalk">
              Network →
            </Link>
            <Link href="/developers#nodes" className="hover:text-chalk">
              API →
            </Link>
          </div>
        }
      >
        The allowlist of models a Brain Node may run, models developers imported from Hugging Face, and which of them have a node online this minute. Availability comes from the coordinator&apos;s registry; VRAM figures are requirements, not measurements. Prices shown are node ask prices when operators set one; otherwise the network list price applies.
      </PageHead>
      <div className="mt-10 space-y-5">
        <ImportedModels />
        <ModelMarket />
      </div>
    </Shell>
  );
}
