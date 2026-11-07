import { getAuthorization, hasPermission } from "@/lib/authorization";
import { currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkedIdReview } from "@/lib/worked-id-review-data";
import { workedIdMonth } from "@/lib/worked-id-review";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
async function access(station: string, edit = false) {
  const a = await getAuthorization();
  if (
    !a?.companyId ||
    !hasPermission(
      a,
      currentProviderMappingPageCode(),
      edit ? "edit" : "access",
    )
  )
    throw Error("Access denied.");
  if (
    !/^[0-9a-f-]{36}$/i.test(station) ||
    (!a.hasAllLocationAccess &&
      !a.isMasterOwner &&
      a.roleCode !== "OWNER" &&
      !a.locationScopeIds.includes(station))
  )
    throw Error("Location access denied.");
  return a;
}
export async function GET(req: Request) {
  try {
    const p = new URL(req.url).searchParams,
      station = p.get("station") || "",
      a = await access(station),
      period = workedIdMonth(p.get("month") || "");
    return Response.json(
      await loadWorkedIdReview(a.companyId!, station, period.from, period.to),
      { headers },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not load review." },
      { status: 400, headers },
    );
  }
}
export async function POST(req: Request) {
  try {
    if (req.headers.get("origin") !== new URL(req.url).origin)
      throw Error("Origin check failed.");
    const p = await req.json();
    const a = await access(String(p.stationId), true);
    if (!supabaseAdmin) throw Error("Database unavailable.");
    const result = await supabaseAdmin.rpc("save_workforce_worked_id_review", {
      p_company: a.companyId,
      p_actor: a.userId,
      p_worker: p.workerId,
      p_station: p.stationId,
      p_date: p.date,
      p_decision: p.decision,
      p_reason: p.reason,
      p_expected_version: p.version,
      p_shares: p.shares || [],
    });
    if (result.error) throw Error(result.error.message);
    let warning = "";
    try {
      const period = workedIdMonth(String(p.date).slice(0, 7));
      const refreshed = await refreshWorkforcePayoutPublicationJobs({
        // Server refresh may include the same person's prior/later station in
        // this month. Only summary status is returned to the scoped reviewer.
        companyId: a.companyId!,
        workforceIds: result.data.affected_workforce_ids,
        periodStart: period.from,
        periodEnd: period.to,
        deadlineAtMs: Date.now() + 45000,
        limit: 10,
      });
      if (
        refreshed.failed ||
        refreshed.remainingUnfinished ||
        refreshed.warnings.length
      )
        warning =
          "Saved. Published payout refresh is pending; check Workforce Payouts before release.";
    } catch {
      warning =
        "Saved. Published payout refresh is pending; check Workforce Payouts before release.";
    }
    return Response.json(
      {
        review: result.data,
        message:
          warning ||
          "Saved. Live calculations updated; existing published payouts refreshed.",
      },
      { headers },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Review was not saved." },
      { status: 400, headers },
    );
  }
}
