import { recoveryActionAllowed, departedPersonError } from "@/lib/ops-pulse/loss-recovery-controls";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { loadRecoveryPayables } from "@/lib/ops-pulse/nl-recovery-payables";
import { assertLifecycleAction, lossLifecycleActors } from "@/lib/ops-pulse/nl-loss-lifecycle";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { deductionMonth } from "@/lib/ops-pulse/nl-loss-policy";
import { hasPermission } from "@/lib/authorization";
import { readAllRows } from "@/lib/supabase-pagination";
export const maxDuration = 120;
export const dynamic = "force-dynamic";
/** A plan saved with a restricted outcome can only be replaced or removed by people who may set it. */
async function lockedPlan(company: string, month: string, caseKey: string) {
  const plan = await supabaseAdmin!
    .from("nl_loss_recoveries")
    .select("outcome_code,is_deleted")
    .eq("company_id", company)
    .eq("month", month)
    .eq("case_key", caseKey)
    .maybeSingle();
  if (!plan.data || plan.data.is_deleted) return null;
  const outcome = await supabaseAdmin!
    .from("nl_recovery_outcomes")
    .select("*")
    .eq("company_id", company)
    .eq("code", plan.data.outcome_code)
    .maybeSingle();
  return outcome.data?.restricted ? (outcome.data.label as string) : null;
}
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
    const { auth, scope, station, settings, caseKey, amount, report, finalSeenAt } =
      await recoveryContext(month, key, false);
    const selectedRefs = url.searchParams.getAll("person");
    if (selectedRefs.length > 50) return reply({ error: "Select up to 50 people." }, 400);
    const directoryOnly = url.searchParams.get("directory") === "1";
    // The salary month payroll deducts a plan saved now in, from the same rule the database applies.
    const salaryMonth = async (timing: "current_month" | "next_month") => {
      const r = await supabaseAdmin!.rpc("nl_recovery_deduction_month", {
        p_report: report,
        p_case_month: month,
        p_assigned_at: new Date().toISOString(),
        p_final_seen_at: finalSeenAt,
        p_timing: timing,
        p_cutoff_day: Number(settings?.recovery_policy?.payroll_cutoff_day) || 7,
      });
      return r.error ? deductionMonth(timing) : (r.data as string | null);
    };
    const [people, history, currentMonth, nextMonth, actors] = await Promise.all([
      directoryOnly
        ? supabaseAdmin!.rpc("station_audit_employee_directory", { p_company: scope.company, p_station: station.id }).then(({ data, error }) => {
            if (error) throw Error("Station employees could not be loaded.");
            return data ?? [];
          })
        : loadRecoveryPayables(auth, scope.company, station.id, month, caseKey, settings!.recovery_policy, settings!.updated_at, selectedRefs.length ? selectedRefs : undefined),
      readAllRows(
        supabaseAdmin!
          .from("nl_loss_recovery_events")
          .select("id,after_value,actor_name,created_at")
          .eq("company_id", scope.company)
          .eq("month", month)
          .eq("case_key", caseKey)
          .order("created_at", { ascending: false }),
      ),
      salaryMonth("current_month"),
      salaryMonth("next_month"),
      lossLifecycleActors(auth, station.id),
    ]);
    if (history.error)
      throw Error("Recovery people and history could not be loaded.");
    return reply({
      case_key: caseKey,
      amount,
      deduction_months: {
        current_month: currentMonth,
        next_month: nextMonth,
      },
      // SLP is deducted only once its Final file is in; the month above is provisional until then.
      awaiting_final: report === "slp" && !finalSeenAt,
      people,
      can_propose: !auth.readOnly && hasPermission(auth, "ops_losses", "edit") && (actors.isCluster || actors.isSlp),
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
      .select("*")
      .eq("company_id", scope.company)
      .eq("code", body.outcome)
      .maybeSingle();
    if (outcome.error) throw Error("Recovery outcome could not be loaded.");
    if (!outcome.data || !recoveryActionAllowed(outcome.data)) return reply({ error: "Use a recovery plan or record the responsible person. Redisputes are managed in Case response." }, 400);
    await assertLifecycleAction(auth, station.id, "propose");
    if (body.outcome === "responsible_left") {
      const error = departedPersonError(body.recovery_details ?? {}, body.remarks);
      if (error) return reply({ error }, 400);
    }
    if (
      outcome.data?.restricted &&
      !hasPermission(auth, "ops_loss_recovered", "edit")
    )
      return reply(
        { error: `You do not have access to mark a case as “${outcome.data.label}”.` },
        403,
      );
    if (!hasPermission(auth, "ops_loss_recovered", "edit")) {
      const locked = await lockedPlan(scope.company, body.month, caseKey);
      if (locked)
        return reply({ error: `This case is marked “${locked}”. Only people with that access can change it.` }, 403);
    }
    if (outcome.data?.allocation_required) {
      // Station users may dispute/clarify only — recovery plans are Cluster propose → SLP approve.
      await assertLifecycleAction(auth, station.id, "propose");
      await loadRecoveryPayables(
        auth,
        scope.company,
        station.id,
        body.month,
        caseKey,
        settings!.recovery_policy,
        settings!.updated_at,
        body.allocations.map((a: { employee_ref: string }) => a.employee_ref),
      );
    }
    if (JSON.stringify(body.recovery_details || {}).length > 20000)
      return reply({ error: "Re-dispute details are too long." }, 400);
    // Full or recurring debit; the database validates the schedule and the salary cap.
    const rawPlan = body.plan && typeof body.plan === "object" ? body.plan : {};
    const plan = {
      mode: rawPlan.mode === "installments" ? "installments" : "full",
      basis: rawPlan.basis === "months" || rawPlan.basis === "amount" ? rawPlan.basis : null,
      value: rawPlan.value == null ? null : String(rawPlan.value).trim().slice(0, 20),
      cap_override: rawPlan.cap_override === true,
      cap_override_reason:
        typeof rawPlan.cap_override_reason === "string" ? rawPlan.cap_override_reason.slice(0, 500) : null,
    };
    // Recovering beyond the salary cap is a Master-level decision, like the cap itself.
    if (plan.cap_override && !hasPermission(auth, "ops_loss_master", "edit")) {
      const saved = await supabaseAdmin!
        .from("nl_loss_recoveries")
        .select("cap_override,is_deleted")
        .eq("company_id", scope.company)
        .eq("month", body.month)
        .eq("case_key", caseKey)
        .maybeSingle();
      // Keeping an override someone with access already recorded is allowed; adding one is not.
      if (!saved.data?.cap_override || saved.data.is_deleted)
        return reply({ error: "Only people with Loss Recovery Master edit access can recover beyond the salary cap." }, 403);
    }
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
      p_plan: plan,
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
    const { auth, scope, station, caseKey } = await recoveryContext(
      String(b.month || ""),
      String(b.case_key || ""),
      true,
    );
    if (!Number.isInteger(b.version) || b.version < 1)
      return reply({ error: "Invalid recovery version." }, 400);
    // Station users may dispute/clarify only — clearing a plan is Cluster/SLP.
    await assertLifecycleAction(auth, station.id, "propose");
    if (!hasPermission(auth, "ops_loss_recovered", "edit")) {
      const locked = await lockedPlan(scope.company, b.month, caseKey);
      if (locked)
        return reply({ error: `This case is marked “${locked}”. Only people with that access can remove it.` }, 403);
    }
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
