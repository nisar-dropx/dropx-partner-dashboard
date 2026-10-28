import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { redactRecoverySnapshot } from "@/lib/ops-pulse/loss-recovery-pay-privacy";

export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "private, no-store" },
});

/** Read-only audit access uses the same company, station and case checks as recovery. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url), month = url.searchParams.get("month") || "";
    const { scope, caseKey } = await recoveryContext(month, url.searchParams.get("case") || "", false, true);
    const result = await readAllRows(supabaseAdmin!.from("nl_loss_recovery_events")
      .select("id,actor_name,created_at,before_value,after_value")
      .eq("company_id", scope.company).eq("month", month).eq("case_key", caseKey)
      .order("created_at", { ascending: false }).order("id", { ascending: false }));
    if (result.error) return reply({ error: "Shipment history could not be loaded. Please retry." }, 500);
    return reply({ history: (result.data || []).map(event => ({ ...event,
      before_value: redactRecoverySnapshot(event.before_value),
      after_value: redactRecoverySnapshot(event.after_value),
    })) });
  } catch {
    return reply({ error: "Shipment history is unavailable or outside your station access." }, 403);
  }
}
