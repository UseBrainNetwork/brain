import { listModels } from "@/api/gateway";
import { json } from "@/services/security";

export async function GET() {
  return json(listModels());
}
