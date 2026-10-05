import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { loadRecoveryPayables } from "@/lib/ops-pulse/nl-recovery-payables";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { deductionMonth } from "@/lib/ops-pulse/nl-loss-policy";
import { readAllRows } from "@/lib/supabase-pagination";
export const maxDuration = 120;
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      month = url.searchParams.get("month") || "",
      key = url.searchParams.get("case") || "";
    const { auth, scope, station, settings, caseKey, amount } =
      await recoveryContext(month, key, false);
    const [people, history] = await Promise.all([
      loadRecoveryPayables(
        auth,
        scope.company,
        station.id,
        month,
        caseKey,
        settings!.recovery_policy,
        settings!.updated_at,
      ),
      readAllRows(
        supabaseAdmin!
          .from("nl_loss_recovery_events")
          .select("id,after_value,actor_name,created_at")
          .eq("company_id", scope.company)
          .eq("month", month)
          .eq("case_key", caseKey)
          .order("created_at", { ascending: false }),
      ),
    ]);
    if (history.error)
      throw Error("Recovery people and history could not be loaded.");
    return reply({
      case_key: caseKey,
      amount,
      deduction_months: {
        current_month: deductionMonth("current_month"),
        next_month: deductionMonth("next_month"),
      },
      people,
      history: history.data ?? [],
    });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to load recovery." },
      403,
    );
  }
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    const body = await request.json();
    const { auth, scope, station, settings, caseKey } = await recoveryContext(
      String(body.month || ""),
      String(body.case_key || ""),
      true,
    );
    if (
      !Number.isInteger(body.version) ||
      body.version < 0 ||
      !Array.isArray(body.allocations) ||
      body.allocations.length > 50 ||
      typeof body.outcome !== "string" ||
      typeof body.remarks !== "string" ||
      body.remarks.length > 2000
    )
      return reply({ error: "Invalid recovery values." }, 400);
    const outcome = await supabaseAdmin!
      .from("nl_recovery_outcomes")
      .select("allocation_required")
      .eq("company_id", scope.company)
      .eq("code", body.outcome)
      .maybeSingle();
    if (outcome.error) throw Error("Recovery outcome could not be loaded.");
    if (outcome.data?.allocation_required)
      await loadRecoveryPayables(
        auth,
        scope.company,
        station.id,
        body.month,
        caseKey,
        settings!.recovery_policy,
        settings!.updated_at,
      );
    if (JSON.stringify(body.recovery_details || {}).length > 20000)
      return reply({ error: "Re-dispute details are too long." }, 400);
    const result = await supabaseAdmin!.rpc("save_nl_recovery", {
      p_company: scope.company,
      p_month: body.month,
      p_case: caseKey,
      p_version: body.version,
      p_outcome: body.outcome,
      p_mode: body.split_mode,
      p_allocations: body.allocations,
      p_remarks: body.remarks,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
      p_details: body.recovery_details || {},
    });
    if (result.error)
      return reply(
        {
          error:
            result.error.code === "P0001"
              ? result.error.message
              : "Recovery could not be saved. Refresh and try again.",
        },
        409,
      );
    return reply({ recovery: result.data });
  } catch (e) {
    return reply(
      {
        error: e instanceof Error ? e.message : "Recovery could not be saved.",
      },
      403,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    const b = await request.json();
    const { auth, scope, caseKey } = await recoveryContext(
      String(b.month || ""),
      String(b.case_key || ""),
      true,
    );
    if (!Number.isInteger(b.version) || b.version < 1)
      return reply({ error: "Invalid recovery version." }, 400);
    const r = await supabaseAdmin!.rpc("clear_nl_recovery", {
      p_company: scope.company,
      p_month: b.month,
      p_case: caseKey,
      p_version: b.version,
      p_actor: auth.userId,
      p_name: auth.fullName || auth.email || "OpsPulse user",
    });
    if (r.error)
      return reply(
        {
          error:
            r.error.code === "P0001"
              ? r.error.message
              : "Recovery could not be removed.",
        },
        409,
      );
    return reply({ recovery: r.data });
  } catch (e) {
    return reply(
      {
        error:
          e instanceof Error ? e.message : "Recovery could not be removed.",
      },
      403,
    );
  }
}
