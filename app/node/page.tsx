import type { Metadata } from "next";
import { NodeScreen } from "@/components/node/NodeScreen";

export const metadata: Metadata = { title: "Node", robots: { index: false } };

export default function NodePage() {
  return <NodeScreen />;
}
