import { listModels } from "@/api/gateway";
import { json } from "@/services/security";

export const dynamic = "force-dynamic";

export async function GET() {
  return json(await listModels());
}
