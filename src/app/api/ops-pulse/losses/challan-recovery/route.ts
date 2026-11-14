import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadChallanRecovery } from "@/lib/ops-pulse/challan-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET() {
  try {
    const auth = await getAuthorization();
    if (!auth) return reply({ error: "Login required." }, 401);
    if (!hasPermission(auth, "ops_losses", "access")) return reply({ error: "Loss access denied." }, 403);
    const view = await loadChallanRecovery(auth);
    return reply(view);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Challan recovery could not be loaded." }, 400);
  }
}

type AllocInput = {
  ref?: string;
  name?: string;
  utr?: string;
  amount?: number | string;
  salary_month?: string;
  installment_no?: number;
  installment_count?: number;
  remarks?: string;
};

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) return reply({ error: "Database service is unavailable." }, 500);
    const auth = await getAuthorization();
    if (!auth) return reply({ error: "Login required." }, 401);
    if (auth.readOnly) return reply({ error: "Read-only preview cannot assign recovery." }, 403);
    if (!hasPermission(auth, "ops_losses", "edit")) return reply({ error: "Loss edit permission denied." }, 403);
    const companyId = requireCompanyId(auth);

    const body = await request.json().catch(() => ({}));
    const caseId = String(body.caseId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) return reply({ error: "A valid recovery case is required." }, 400);
    const splitMode = String(body.splitMode || "custom").trim().toLowerCase();
    const remarks = String(body.remarks || "").trim();
    const allocations = Array.isArray(body.allocations) ? (body.allocations as AllocInput[]) : [];
    if (!allocations.length) return reply({ error: "Add at least one associate to recover from." }, 400);

    // Confirm the case is within the caller's station scope.
    const view = await loadChallanRecovery(auth);
    const target = view.cases.find((c) => c.id === caseId);
    if (!target) return reply({ error: "This recovery case is outside your assigned stations." }, 403);

    const payload = allocations.map((a) => ({
      ref: String(a.ref || "").trim(),
      name: String(a.name || "").trim(),
      utr: String(a.utr || "").trim(),
      amount: Number(a.amount) || 0,
      salary_month: String(a.salary_month || "").trim(),
      installment_no: Number(a.installment_no) || 1,
      installment_count: Number(a.installment_count) || 1,
      remarks: String(a.remarks || "").trim()
    }));

    const result = await supabaseAdmin.rpc("fleet_challan_recovery_assign_v1", {
      p_company: companyId,
      p_case: caseId,
      p_user: auth.userId,
      p_name: auth.fullName || auth.email || "Fleet user",
      p_split_mode: splitMode,
      p_allocations: payload,
      p_remarks: remarks || null
    });
    if (result.error) return reply({ error: result.error.message }, 400);

    const refreshed = await loadChallanRecovery(auth);
    return reply({ ok: true, view: refreshed });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Recovery could not be saved." }, 400);
  }
}
