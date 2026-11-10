import { assertReleaseStation, paymentReleaseAccess } from "@/lib/payment-release-access";
import { hasPermission } from "@/lib/authorization";
import { readAllRows } from "@/lib/supabase-pagination";
import { buildWorkforceFedOneWorkbook } from "@/lib/workforce-payout-bank-file";
import { payrollNextStep, type PayrollPreview } from "@/lib/people-payroll-finance";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(request: Request) {
  try {
    const { auth, company, db } = await paymentReleaseAccess(false, true);
    const requestId = new URL(request.url).searchParams.get("request");
    if (requestId) {
      if (!uuid.test(requestId)) throw Error("Choose a payroll submission.");
      const submission = await db.from("people_finance_requests").select("id,station_id,run_id").eq("company_id", company).eq("id", requestId).maybeSingle();
      if (submission.error || !submission.data) throw Error("Payroll submission was not found.");
      await assertReleaseStation(auth, company, submission.data.station_id);
      const [review, batches, events] = await Promise.all([
        db.rpc("people_finance_payment_preview", { p_company: company, p_run: submission.data.run_id, p_station: submission.data.station_id }),
        db.from("people_finance_bank_batches").select("id,bank_id,value_date,created_at").eq("company_id", company).eq("request_id", requestId).order("created_at", { ascending: false }),
        db.from("people_finance_events").select("action,reason,actor_id,created_at").eq("company_id", company).eq("request_id", requestId).order("created_at", { ascending: false }).limit(50)
      ]);
      if (review.error || batches.error || events.error) throw Error("Payroll review could not be loaded.");
      return Response.json({ ...review.data, batches: batches.data, events: events.data }, { headers });
    }
    let query = db.from("people_finance_requests").select("*").eq("company_id", company).order("submitted_at", { ascending: false });
    if (!auth.hasAllLocationAccess) query = query.in("station_id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
    const requests = await readAllRows(query);
    if (requests.error) throw Error("Finance submissions could not be loaded.");
    const ids = [...new Set((requests.data ?? []).map(r => r.station_id))];
    const runIds = [...new Set((requests.data ?? []).map(r => r.run_id))];
    const actorIds = [...new Set((requests.data ?? []).map(r => r.submitted_by))];
    const [stations, runs, banks, profiles, policy, combined] = await Promise.all([
      ids.length ? readAllRows(db.from("stations").select("id,station_code,station_name").eq("company_id", company).in("id", ids).order("id")) : { data: [], error: null },
      runIds.length ? readAllRows(db.from("hr_payroll_runs").select("id,label,period_start,status").eq("company_id", company).in("id", runIds).order("id")) : { data: [], error: null },
      db.from("payment_banks").select("id,display_name").eq("company_id", company).eq("is_active", true).eq("bank_code", "FEDERAL_BANK"),
      actorIds.length ? db.from("profiles").select("id,full_name").eq("company_id", company).in("id", actorIds) : { data: [], error: null },
      db.from("nl_loss_sources").select("recovery_policy").eq("company_id", company),
      db.from("people_finance_combined_batches").select("id,request_ids,bank_id,value_date,line_count,amount_paise,created_at").eq("company_id", company).order("created_at", { ascending: false }).limit(50)
    ]);
    if (stations.error || runs.error || banks.error || profiles.error || policy.error || combined.error) throw Error("Finance payroll could not be loaded.");
    const canEdit = !auth.readOnly && hasPermission(auth, "payment_process", "edit");
    const clearanceRequired = !policy.data?.some(p => p.recovery_policy?.require_loss_payment_clearance === false);
    const rows = [];
    for (let i = 0; i < (requests.data ?? []).length; i += 4) {
      rows.push(...await Promise.all((requests.data ?? []).slice(i, i + 4).map(async r => {
        const station = stations.data?.find(s => s.id === r.station_id);
        const run = runs.data?.find(x => x.id === r.run_id);
        if (!run) throw Error("A salary period could not be loaded.");
        const [preview, loss] = await Promise.all([
          db.rpc("people_finance_payment_preview", { p_company: company, p_run: r.run_id, p_station: r.station_id }),
          db.rpc("loss_payment_release_review", { p_company: company, p_station: r.station_id, p_month: run.period_start.slice(0, 7), p_scope: `people:${r.run_id}` })
        ]);
        if (preview.error || loss.error) throw Error(`${station?.station_code ?? "Location"}: payment readiness could not be checked. Refresh to retry.`);
        const { people: _people, ...summary } = preview.data as PayrollPreview;
        const row = { ...r, ...summary, station: station?.station_code ?? "Unknown location", station_name: station?.station_name ?? "", run,
          submitted_name: profiles.data?.find(p => p.id === r.submitted_by)?.full_name || "Payroll submitter",
          clearance: Boolean(loss.data?.approval), clearanceRequired, lossPending: Number(loss.data?.pendingCount ?? 0) + Number(loss.data?.missingDeductionCount ?? 0) };
        const requiresOverride = r.status === "returned" || (r.status === "submitted" && r.submitted_by === auth.userId);
        let canOverride = false;
        if (canEdit && requiresOverride) {
          const allowed = await db.rpc("people_finance_override_allowed", { p_company: company, p_actor: auth.userId, p_station: r.station_id });
          if (allowed.error) throw Error("Payroll override access could not be checked.");
          canOverride = allowed.data === true;
        }
        const canProcess = canEdit && !row.changed && row.runApproved && (row.clearance || !clearanceRequired) && row.readyCount > 0 && !row.issues.length && (!requiresOverride || canOverride);
        return { ...row, requiresOverride, canOverride, canProcess, nextStep: canProcess ? requiresOverride ? 'Managing Partner override available — reason required' : r.status === 'approved' ? 'Ready to download' : 'Approve and download together' : payrollNextStep(row, auth.userId),
          canApprove: canEdit && !row.changed && row.runApproved && r.status === "submitted" && r.submitted_by !== auth.userId && (row.clearance || !clearanceRequired),
          canDownload: canEdit && !row.changed && row.runApproved && r.status === "approved" && (row.clearance || !clearanceRequired) && row.readyCount > 0 && !row.issues.length };
      })));
    }
    const permitted = new Set(rows.map(r => r.id));
    return Response.json({ requests: rows, banks: banks.data, canEdit, actorId: auth.userId,
      batches: combined.data?.filter(b => b.request_ids.every((id: string) => permitted.has(id))) }, { headers });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Finance payroll unavailable." }, { status: 400, headers }); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) throw Error("Invalid origin.");
    const { auth, company, db } = await paymentReleaseAccess(true, true);
    const body = await request.json();
    const combined = ["bank_file_combined", "approve_download"].includes(body.action);
    const ids: string[] = combined ? body.requestIds : [body.requestId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !uuid.test(String(id))) || new Set(ids).size !== ids.length) throw Error("Choose distinct payroll submissions (up to 100 locations).");
    const submissions = await db.from("people_finance_requests").select("id,station_id,run_id").eq("company_id", company).in("id", ids);
    if (submissions.error || submissions.data?.length !== ids.length) throw Error("A payroll submission was not found.");
    for (const s of submissions.data) await assertReleaseStation(auth, company, s.station_id);
    if (["bank_file", "bank_file_combined", "approve_download"].includes(body.action)) {
      if (!uuid.test(String(body.operationId)) || !uuid.test(String(body.bankId)) || !/^20\d{2}-\d{2}-\d{2}$/.test(String(body.valueDate))) throw Error("Choose the bank and value date before downloading.");
      const result = combined
        ? await db.rpc(body.action === "approve_download" ? "people_finance_approve_and_issue" : "people_finance_issue_many", { p_company: company, p_requests: ids, p_actor: auth.userId, p_operation: body.operationId, p_bank: body.bankId, p_value_date: body.valueDate, p_expected: body.expected ?? null,
          ...(body.action === "approve_download" ? { p_override_reason: typeof body.overrideReason === 'string' ? body.overrideReason : null } : {}) })
        : await db.rpc("people_finance_issue", { p_company: company, p_request: ids[0], p_actor: auth.userId, p_operation: body.operationId, p_bank: body.bankId, p_value_date: body.valueDate });
      if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Bank file could not be created. Refresh before retrying.");
      const instructions = result.data.instructions;
      if (!Array.isArray(instructions) || !instructions.length) throw Error("No bank instructions returned.");
      const workbook = buildWorkforceFedOneWorkbook({ debitAccountNumber: instructions[0].debitAccountNumber, valueDate: instructions[0].valueDate, referencePrefix: "HR", instructions });
      return new Response(Buffer.from(workbook), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="people-payroll-${body.valueDate}-${body.operationId}.xlsx"` } });
    }
    if (body.action === "approve" && !String(body.reason ?? '').trim()) body.reason = "Payroll reviewed and approved for payment.";
    if (!["approve", "return"].includes(body.action) || !Number.isInteger(body.version) || typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 2000) throw Error("Record a correction reason (10–2000 characters).");
    const result = await db.rpc("people_finance_decide", { p_company: company, p_request: ids[0], p_actor: auth.userId, p_version: body.version, p_action: body.action, p_reason: body.reason });
    if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Finance decision failed.");
    return Response.json({ ok: true }, { headers });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Finance action failed." }, { status: 409, headers }); }
}
