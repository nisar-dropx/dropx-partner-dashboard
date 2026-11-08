import { assertReleaseStation, paymentReleaseAccess } from "@/lib/payment-release-access";
import { readAllRows } from "@/lib/supabase-pagination";
import { buildWorkforceFedOneWorkbook } from "@/lib/workforce-payout-bank-file";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    const { auth, company, db } = await paymentReleaseAccess(false, true);
    const requestId = new URL(request.url).searchParams.get("request");
    if (requestId) {
      const submission = await db.from("people_finance_requests").select("id,station_id,run_id").eq("company_id", company).eq("id", requestId).maybeSingle();
      if (submission.error || !submission.data) throw Error("Payroll submission was not found.");
      await assertReleaseStation(auth, company, submission.data.station_id);
      const [review, batches, events] = await Promise.all([
        db.rpc("people_finance_submission_review", { p_company: company, p_run: submission.data.run_id, p_station: submission.data.station_id }),
        db.from("people_finance_bank_batches").select("id,bank_id,value_date,created_at").eq("company_id", company).eq("request_id", requestId).order("created_at", { ascending: false }),
        db.from("people_finance_events").select("action,reason,actor_id,created_at").eq("company_id", company).eq("request_id", requestId).order("created_at", { ascending: false }).limit(30)
      ]);
      if (review.error || batches.error || events.error) throw Error("Payroll review could not be loaded.");
      return Response.json({ ...review.data, batches: batches.data, events: events.data }, { headers });
    }
    let query = db.from("people_finance_requests").select("*").eq("company_id", company).order("submitted_at", { ascending: false });
    if (!auth.hasAllLocationAccess) query = query.in("station_id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
    const [requests, stations, runs, banks] = await Promise.all([
      readAllRows(query),
      readAllRows(db.from("stations").select("id,station_code,station_name").eq("company_id", company).order("id")),
      db.from("hr_payroll_runs").select("id,label,period_start,status").eq("company_id", company).order("period_start", { ascending: false }),
      db.from("payment_banks").select("id,display_name").eq("company_id", company).eq("is_active", true).eq("bank_code", "FEDERAL_BANK")
    ]);
    if (requests.error || stations.error || runs.error || banks.error) throw Error("Finance payroll could not be loaded.");
    const rows = (requests.data ?? []).map(r => ({ ...r, station: stations.data?.find(s => s.id === r.station_id)?.station_code ?? "Unknown station", run: runs.data?.find(run => run.id === r.run_id) }));
    return Response.json({ requests: rows, banks: banks.data }, { headers });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Finance payroll unavailable." }, { status: 400, headers }); }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) throw Error("Invalid origin.");
    const { auth, company, db } = await paymentReleaseAccess(true, true);
    const body = await request.json();
    if (!/^[0-9a-f-]{36}$/i.test(String(body.requestId))) throw Error("Choose a payroll submission.");
    const submission = await db.from("people_finance_requests").select("id,station_id,run_id").eq("company_id", company).eq("id", body.requestId).maybeSingle();
    if (submission.error || !submission.data) throw Error("Payroll submission was not found.");
    await assertReleaseStation(auth, company, submission.data.station_id);
    if (body.action === "bank_file") {
      const result = await db.rpc("people_finance_issue", { p_company: company, p_request: body.requestId, p_actor: auth.userId, p_operation: body.operationId, p_bank: body.bankId, p_value_date: body.valueDate });
      if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Bank file could not be created.");
      const instructions = result.data.instructions;
      if (!Array.isArray(instructions) || !instructions.length) throw Error("No bank instructions returned.");
      const workbook = buildWorkforceFedOneWorkbook({ debitAccountNumber: instructions[0].debitAccountNumber, valueDate: instructions[0].valueDate, referencePrefix: "HR", instructions });
      return new Response(Buffer.from(workbook), { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="people-payroll-${body.requestId}-${body.operationId}.xlsx"` } });
    }
    const result = await db.rpc("people_finance_decide", { p_company: company, p_request: body.requestId, p_actor: auth.userId, p_version: body.version, p_action: body.action, p_reason: body.reason });
    if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Finance decision failed.");
    return Response.json({ ok: true }, { headers });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Finance action failed." }, { status: 409, headers }); }
}
