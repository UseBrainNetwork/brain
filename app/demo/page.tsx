import type { Metadata } from "next";
import { DemoScreen } from "@/components/demo/DemoScreen";

export const metadata: Metadata = { title: "Live network", robots: { index: false } };

export default function DemoPage() {
  return <DemoScreen />;
}
