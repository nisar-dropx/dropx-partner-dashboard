import {
  recoveryActionAllowed,
  departedPersonError,
  receivedRecoveryError,
  mayActivateRedispute,
  mayMarkAlreadyRecovered,
  filterLossRecoveryDebitPeople,
} from "@/lib/ops-pulse/loss-recovery-controls";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { loadRecoveryPayables, loadRecoveryDirectory } from "@/lib/ops-pulse/nl-recovery-payables";
import { assertLifecycleAction } from "@/lib/ops-pulse/nl-loss-lifecycle";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { refreshLossPayroll } from "@/lib/ops-pulse/loss-payroll-refresh";
import { hasPermission } from "@/lib/authorization";
import { readAllRows } from "@/lib/supabase-pagination";
import type { RecoveryPerson } from "@/lib/ops-pulse/nl-loss-policy";
import {
  privacySafeRecoveryError,
  recoveryPersonPayDisclosure,
  redactRecoverySnapshot,
} from "@/lib/ops-pulse/loss-recovery-pay-privacy";
export const maxDuration = 120;
export const dynamic = "force-dynamic";
/** A plan saved with a restricted outcome can only be replaced or removed by people who may set it. */
async function lockedPlan(company: string, month: string, caseKey: string) {
  const plan = await supabaseAdmin!
    .from("nl_loss_recoveries")
    .select("outcome_code,is_deleted,approval_status")
    .eq("company_id", company)
    .eq("month", month)
    .eq("case_key", caseKey)
    .maybeSingle();
  if (!plan.data || plan.data.is_deleted || plan.data.approval_status !== "approved") return null;
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
    const responseWindow = await supabaseAdmin!.from("nl_case_response_windows").select("enabled,workflow_status,recovery_month").eq("company_id", scope.company).eq("month", month).eq("case_key", caseKey).maybeSingle();
    if(responseWindow.error) throw Error("Redispute status could not be loaded.");
    const grants = await supabaseAdmin!.from('nl_loss_exception_options').select('kind,enabled,deduction_month,source_amount,source_status').eq('company_id',scope.company).eq('month',month).eq('case_key',caseKey);
    if (grants.error) throw Error('Exception options could not be loaded. Reload and retry.');
    const allowed = await Promise.all(['next_month','installments'].map(kind=>supabaseAdmin!.rpc('nl_loss_exception_allowed',{p_company:scope.company,p_month:month,p_case:caseKey,p_kind:kind,p_payroll:grants.data?.find(g=>g.kind===kind)?.deduction_month || null})));
    if (allowed.some(r=>r.error)) throw Error('Exception options could not be verified.');
    // The salary month payroll deducts a plan saved now in, from the same rule the database applies.
    const salaryMonth = async (timing: "current_month" | "next_month") => {
      const r = await supabaseAdmin!.rpc("nl_recovery_deduction_month", {
        p_report: report,
        p_case_month: month,
        p_assigned_at: new Date().toISOString(),
        p_final_seen_at: finalSeenAt,
        p_timing: timing,
        p_cutoff_day: Number(settings?.recovery_policy?.payroll_cutoff_day) || 5,
      });
      if (r.error) throw Error("Payroll month could not be resolved. Please retry.");
      const resolved = r.data as string | null;
      return responseWindow.data?.recovery_month && (!resolved || responseWindow.data.recovery_month > resolved) ? responseWindow.data.recovery_month as string : resolved;
    };
    const currentMonth = await salaryMonth("current_month");
    const requestedPayrollMonth = url.searchParams.get("payroll_month") || currentMonth;
    if (!requestedPayrollMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedPayrollMonth)) throw Error("Choose a valid payroll month.");
    const [people, history, nextMonth] = await Promise.all([
      directoryOnly
        ? loadRecoveryDirectory(scope.company, station.id, url.searchParams.get("departed") === "1")
        : loadRecoveryPayables(auth, scope.company, station.id, month, caseKey, settings!.recovery_policy, settings!.updated_at, selectedRefs.length ? selectedRefs : undefined, requestedPayrollMonth, url.searchParams.get("departed") === "1"),
      readAllRows(
        supabaseAdmin!
          .from("nl_loss_recovery_events")
          .select("id,after_value,actor_name,created_at")
          .eq("company_id", scope.company)
          .eq("month", month)
          .eq("case_key", caseKey)
          .order("created_at", { ascending: false }),
      ),
      salaryMonth("next_month"),
    ]);
    if (history.error)
      throw Error("Recovery people and history could not be loaded.");
    return reply({
      case_key: caseKey,
      amount,
      exception_options: { installments: allowed[1].data === true, next_month: allowed[0].data === true ? grants.data?.find(g=>g.kind==='next_month')?.deduction_month : null },
      deduction_months: {
        current_month: currentMonth,
        next_month: nextMonth,
      },
      // SLP is deducted only once its Final file is in; the month above is provisional until then.
      awaiting_final: report === "slp" && !finalSeenAt,
      people: people.map(recoveryPersonPayDisclosure),
      can_propose: !auth.readOnly && hasPermission(auth, "ops_losses", "edit") && responseWindow.data?.workflow_status !== "won",
      can_approve: mayActivateRedispute(auth) && hasPermission(auth,"ops_losses","edit") && history.data?.[0]?.after_value?.proposed_by !== auth.userId,
      can_recovered: false,
      can_response: !!responseWindow.data?.enabled,
      history: (history.data ?? []).map((event) => ({
        ...event,
        after_value: redactRecoverySnapshot(event.after_value),
      })),
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
    const { auth, scope, station, settings, caseKey, amount, report, finalSeenAt } = await recoveryContext(
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
    if (body.outcome === "already_recovered") {
      if (!mayMarkAlreadyRecovered(auth) || !hasPermission(auth, "ops_losses", "edit"))
        return reply({ error: "Only Cluster Manager and above can mark a case as already recovered." }, 403);
      const error = receivedRecoveryError(body.recovery_details ?? {}, Number(amount));
      if (error) return reply({ error }, 400);
    }
    if (body.outcome === "responsible_left") {
      const error = departedPersonError(body.recovery_details ?? {}, body.remarks);
      if (error) return reply({ error }, 400);
      const leavers = await loadRecoveryDirectory(scope.company, station.id, true);
      const leaver = leavers.find(p => p.ref === body.recovery_details.employee_ref);
      if (!leaver) return reply({error:"This person is no longer in the verified departure list. Refresh before saving."},409);
      if (body.allocations.length && (body.allocations.length !== 1 || body.allocations[0].employee_ref !== leaver.ref))
        return reply({error:"The salary adjustment must belong to the selected departed person."},400);
    }
    if (
      outcome.data?.restricted &&
      body.outcome !== "already_recovered" &&
      !mayMarkAlreadyRecovered(auth) &&
      !hasPermission(auth, "ops_loss_recovered", "edit")
    )
      return reply(
        { error: `You do not have access to mark a case as “${outcome.data.label}”.` },
        403,
      );
    if (!mayMarkAlreadyRecovered(auth) && !hasPermission(auth, "ops_loss_recovered", "edit") && !mayActivateRedispute(auth)) {
      const locked = await lockedPlan(scope.company, body.month, caseKey);
      if (locked)
        return reply({ error: `This case is marked “${locked}”. Only people with that access can change it.` }, 403);
    }
    const responseWindow = await supabaseAdmin!.from("nl_case_response_windows").select("enabled,workflow_status,recovery_month").eq("company_id",scope.company).eq("month",body.month).eq("case_key",caseKey).maybeSingle();
    if(responseWindow.error) throw Error("Redispute status could not be loaded.");
    if(responseWindow.data?.workflow_status === "won")return reply({error:"Recovery is paused or stopped by redispute. Open the redispute details for this shipment."},409);
    const fundedDeparture = body.outcome === "responsible_left" && body.allocations.length === 1;
    if (fundedDeparture && !body.plan?.deduction_month)
      return reply({error:"Choose an open unpaid payroll month."},400);
    if (outcome.data?.allocation_required && !body.plan?.deduction_month) {
      const resolved = await supabaseAdmin!.rpc("nl_recovery_deduction_month", {p_report:report,p_case_month:body.month,p_assigned_at:new Date().toISOString(),p_final_seen_at:finalSeenAt,p_timing:outcome.data.deduction_timing,p_cutoff_day:settings!.recovery_policy.payroll_cutoff_day || 5});
      if(resolved.error || !resolved.data) throw Error("Payroll month could not be resolved.");
      body.plan={...body.plan,deduction_month:responseWindow.data?.recovery_month && responseWindow.data.recovery_month>resolved.data ? responseWindow.data.recovery_month : resolved.data};
    }
    if (outcome.data?.allocation_required || fundedDeparture) {
      // Check who can assign recovery. Routine plans become eligible in the atomic writer without approval.
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
        body.plan?.deduction_month || undefined,
        fundedDeparture,
      );
    }
    if (JSON.stringify(body.recovery_details || {}).length > 20000)
      return reply({ error: "Re-dispute details are too long." }, 400);
    // Full or recurring debit; the database validates the schedule and available pay.
    const rawPlan = body.plan && typeof body.plan === "object" ? body.plan : {};
    const plan = {
      deduction_month: typeof rawPlan.deduction_month === "string" ? rawPlan.deduction_month : undefined,
      mode: rawPlan.mode === "installments" ? "installments" : "full",
      basis: rawPlan.basis === "months" || rawPlan.basis === "amount" ? rawPlan.basis : null,
      value: rawPlan.value == null ? null : String(rawPlan.value).trim().slice(0, 20),
    };
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
    if (result.error) {
      const includesPeopleProfile = body.allocations.some(
        (allocation: { employee_ref?: unknown }) =>
          !String(allocation?.employee_ref ?? "").startsWith("workforce:"),
      );
      return reply(
        {
          error:
            result.error.code === "P0001"
              ? privacySafeRecoveryError(result.error.message, includesPeopleProfile)
              : "Recovery could not be saved. Refresh and try again.",
        },
        409,
      );
    }
    const payroll_sync = await refreshLossPayroll(scope.company);
    return reply({ recovery: result.data, payroll_sync });
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
    if (!mayMarkAlreadyRecovered(auth) && !hasPermission(auth, "ops_loss_recovered", "edit") && !mayActivateRedispute(auth)) {
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
    const payroll_sync = await refreshLossPayroll(scope.company);
    return reply({ recovery: r.data, payroll_sync });
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
