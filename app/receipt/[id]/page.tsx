import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptView } from "@/components/economy/ReceiptView";
import { Shell } from "@/components/economy/parts";
import { getDecision } from "@/engine/orders";
import { getJob } from "@/services/distributed";
import { getReceipt } from "@/services/receipts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Receipt ${id}`, description: "Proof of compute: nodes, verification, cost." };
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await getReceipt(decodeURIComponent(id));
  if (!receipt) {
    return (
      <Shell>
        <div className="font-mono text-[12px] text-chalk/50">Receipt</div>
        <h1 className="display mt-3 text-[48px] text-chalk">{id}</h1>
        <p className="mt-6 font-mono text-[13px] text-chalk/60">No receipt with this id exists on this server. Receipts live in the server&apos;s store; without a database they do not survive a restart.</p>
        <Link href="/network" className="mt-8 inline-block font-mono text-[12px] text-chalk/70 hover:text-chalk">
          ← Network operations
        </Link>
      </Shell>
    );
  }
  const [job, decision] = await Promise.all([receipt.workloadType === "matmul_u32" ? getJob(receipt.jobId) : null, receipt.route?.decisionId ? getDecision(receipt.route.decisionId) : null]);
  return <ReceiptView receipt={receipt} job={job} decision={decision} />;
}
