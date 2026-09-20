import { getAuthorization, hasPermission } from "@/lib/authorization";
import { loadOffboardingChecklist } from "@/lib/ops-pulse/offboarding-checklist-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_offboarding_checklist", "access")) {
    return Response.json({ error: "Offboarding checklist access is required." }, { status: 403, headers });
  }
  try {
    const data = await loadOffboardingChecklist(auth);
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Offboarding checklist could not be loaded." }, { status: 503, headers });
  }
}
