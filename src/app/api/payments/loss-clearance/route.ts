import { assertReleaseStation, mayApprovePaymentRelease, paymentReleaseAccess } from "@/lib/payment-release-access";
import { readAllRows } from "@/lib/supabase-pagination";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const { auth, company, db } = await paymentReleaseAccess();
    const params = new URL(request.url).searchParams;
    if (params.get("options") === "1") {
      let query = db.from("stations").select("id,station_code,station_name").eq("company_id", company).order("station_code");
      if (!auth.hasAllLocationAccess) query = query.in("id", auth.locationScopeIds.length ? auth.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
      const [stations, runs] = await Promise.all([
        readAllRows(query),
        db.from("hr_payroll_runs").select("id,label,period_start").eq("company_id", company).order("period_start", { ascending: false }).limit(36)
      ]);
      if (stations.error || runs.error) throw Error("Review options could not be loaded.");
      return Response.json({ stations: stations.data, runs: runs.data, canApprove: mayApprovePaymentRelease(auth) }, { headers });
    }
    const station = params.get("station") || "";
    await assertReleaseStation(auth, company, station);
    const result = await db.rpc("loss_payment_release_review", { p_company: company, p_station: station, p_month: params.get("month"), p_scope: params.get("scope") });
    if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Loss clearance could not be loaded.");
    return Response.json(result.data, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Review unavailable." }, { status: 400, headers });
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) throw Error("Invalid origin.");
    const { auth, company, db } = await paymentReleaseAccess(true);
    if (!mayApprovePaymentRelease(auth)) throw Error("Payment release requires SLP Manager, Sales Manager, National Head, Finance Manager or Managing Partner approval.");
    const body = await request.json();
    await assertReleaseStation(auth, company, body.station);
    const result = await db.rpc("loss_payment_release_decide", {
      p_company: company, p_station: body.station, p_month: body.month, p_scope: body.scope,
      p_actor: auth.userId, p_action: body.action, p_fingerprint: body.fingerprint, p_reason: body.reason,
      p_owner: body.owner || null, p_follow_up: body.followUp || null
    });
    if (result.error) throw Error(result.error.code === "P0001" ? result.error.message : "Payment release could not be saved.");
    return Response.json(result.data, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Approval failed." }, { status: 409, headers });
  }
}
