import { getAuthorization, hasPermission } from "@/lib/authorization";
import { loadSalaryHoldWorkspace } from "@/lib/ops-pulse/salary-hold-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_salary_hold", "access")) {
    return Response.json({ error: "Salary hold access is required." }, { status: 403, headers });
  }
  try {
    const data = await loadSalaryHoldWorkspace(auth);
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Salary hold workspace could not be loaded." }, { status: 503, headers });
  }
}
