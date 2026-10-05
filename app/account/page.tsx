import type { Metadata } from "next";
import { AccountDashboard } from "@/components/account/AccountDashboard";
import { PageHead, Shell, SourceBadge } from "@/components/economy/parts";

export const metadata: Metadata = { title: "Account", description: "Your plan, credits, compute earnings and net. Real ledger lines only." };

export default function AccountPage() {
  return (
    <Shell>
      <PageHead
        eyebrow={
          <>
            Account <SourceBadge source="REAL" />
          </>
        }
        title={
          <>
            What you use.
            <br />
            <span className="text-chalk/40">What your machines earn.</span>
          </>
        }
      >
        One account joins both sides of BRAIN. Credits are deducted from the real cost on each receipt; compute earnings are the accrued REAL lines for nodes your wallet powers. Nothing here is projected.
      </PageHead>
      <AccountDashboard />
    </Shell>
  );
}
