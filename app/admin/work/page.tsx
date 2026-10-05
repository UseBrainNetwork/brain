import type { Metadata } from "next";
import { WorkReport } from "@/components/admin/WorkReport";

export const metadata: Metadata = { title: "Epoch work · operator", robots: { index: false, follow: false } };

export default function Page() {
  return <WorkReport />;
}
