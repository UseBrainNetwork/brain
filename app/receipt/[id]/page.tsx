import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptView } from "@/components/economy/ReceiptView";
import { Shell } from "@/components/economy/parts";
import { getDecision } from "@/engine/orders";
import { getJob } from "@/services/distributed";
import { isStoreUnavailable, isTransientDbError } from "@/services/failsoft";
import { getReceipt } from "@/services/receipts";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Receipt ${id}`, description: "Proof of compute: nodes, verification, cost." };
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let receipt;
  try {
    receipt = await getReceipt(decodeURIComponent(id));
  } catch (e) {
    // Database unreachable or slow: say so instead of crashing to the global error boundary.
    if (!isTransientDbError(e)) throw e;
    const retryAfterSec = isStoreUnavailable(e) ? e.retryAfterSec : 15;
    return (
      <Shell>
        <div className="font-mono text-[12px] text-chalk/50">Receipt</div>
        <h1 className="display mt-3 break-all text-[48px] text-chalk">{id}</h1>
        <p className="mt-6 max-w-[520px] font-mono text-[13px] leading-relaxed text-chalk/60">
          The database is not answering right now, so this receipt cannot be read. Nothing is shown that was not read; retry in {retryAfterSec} seconds.
        </p>
        <Link href={`/receipt/${id}`} className="mt-6 inline-block font-mono text-[12px] text-chalk underline underline-offset-4">
          Retry →
        </Link>
      </Shell>
    );
  }
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
