import { notFound } from "next/navigation";
import { LlmCheck } from "./LlmCheck";

/** Development-only: compares the WebGPU stage kernels against the CPU reference on real weights. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LlmCheck />;
}
