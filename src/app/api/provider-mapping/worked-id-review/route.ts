import { getAuthorization, hasPermission } from "@/lib/authorization";
import { currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkedIdReview } from "@/lib/worked-id-review-data";
import { workedIdMonth, workedIdErrorMessage } from "@/lib/worked-id-review";
import { refreshWorkforcePayoutPublicationJobs } from "@/lib/workforce-payout-publication-refresh";
import { workedIdTrainingRouting } from "@/lib/worked-id-training-routing";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
async function access(
  station: string,
  edit = false,
  provided?: Awaited<ReturnType<typeof getAuthorization>>,
) {
  const a = provided || (await getAuthorization());
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
      stationIds = [
        ...new Set(
          (p.get("stations") || p.get("station") || "")
            .split(",")
            .filter(Boolean),
        ),
      ],
      a = await access(stationIds[0] || ""),
      period = workedIdMonth(p.get("month") || "");
    if (stationIds.length > 200) throw Error("Too many locations.");
    for (const station of stationIds) {
      if (
        !/^[0-9a-f-]{36}$/i.test(station) ||
        (!a.hasAllLocationAccess &&
          !a.isMasterOwner &&
          a.roleCode !== "OWNER" &&
          !a.locationScopeIds.includes(station))
      )
        throw Error("Location access denied.");
    }
    if (p.get("worker")) {
      const worker = p.get("worker")!;
      if (!/^[0-9a-f-]{36}$/i.test(worker)) throw Error("Invalid associate.");
      if (p.get("mode") === "evidence")
        return Response.json(
          await loadWorkedIdReview(
            a.companyId!,
            stationIds,
            period.from,
            period.to,
            a.userId,
            worker,
            p.get("scope") === "daily",
          ),
          { headers },
        );
      const calculated = await loadWorkforcePayoutRows(
        a.companyId!,
        { ...a, hasAllLocationAccess: false, locationScopeIds: stationIds },
        period.from,
        period.to,
        { workforceIds: [worker], includeLossRecoveries: false },
      );
      if (calculated.error) throw Error(calculated.error);
      return Response.json(
        {
          pay: calculated.rows.map((r) => ({
            stationId: r.locationId,
            method: r.paymentMethod,
            available: r.paymentDetailsAvailable,
            status: r.status,
            days: r.dailyBreakdown,
          })),
        },
        { headers },
      );
    }
    return Response.json(
      await loadWorkedIdReview(
        a.companyId!,
        stationIds,
        period.from,
        period.to,
        a.userId,
        undefined,
        p.get("scope") === "daily",
      ),
      { headers },
    );
  } catch (e) {
    return Response.json(
      { error: workedIdErrorMessage(e, "Could not load review.") },
      { status: 400, headers },
    );
  }
}
export async function POST(req: Request) {
  try {
    if (req.headers.get("origin") !== new URL(req.url).origin)
      throw Error("Origin check failed.");
    const p = await req.json();
    const entries = Array.isArray(p.entries) ? p.entries : [p];
    if (entries.length < 1 || entries.length > 31)
      throw Error("Select 1–31 days.");
    const a = await access(String(entries[0].stationId));
    if (a.readOnly) throw Error("Read-only access cannot save reviews.");
    if (!supabaseAdmin) throw Error("Database unavailable.");
    const stationIds = [
      ...new Set(entries.map((e: any) => String(e.stationId))),
    ] as string[];
    const routing = await workedIdTrainingRouting(a.companyId!, stationIds);
    const clean = [];
    for (const e of entries) {
      const approval = ["approve_training", "reject_training"].includes(
        e.decision,
      );
      await access(String(e.stationId), !approval, a);
      const item: any = {
        workerId: e.workerId,
        stationId: e.stationId,
        date: e.date,
        version: e.version,
        decision: e.decision,
        reason: e.reason,
        shares: e.shares || [],
        buddySourceId: e.buddySourceId,
      };
      if (e.decision === "training") {
        const route = routing(e.stationId, a.userId);
        item.approverIds = route.userIds;
        item.approverNames = route.names;
        if (!route.userIds.length)
          throw Error(
            "No different Cluster Manager/AOM with an active login is configured for this station.",
          );
      }
      if (approval) {
        const t = await supabaseAdmin
          .from("workforce_buddy_training_requests")
          .select("requested_by,approver_ids,status")
          .eq("company_id", a.companyId!)
          .eq("workforce_id", e.workerId)
          .eq("station_id", e.stationId)
          .eq("work_date", e.date)
          .single();
        if (
          t.error ||
          t.data.requested_by === a.userId ||
          !t.data.approver_ids.includes(a.userId) ||
          !routing(e.stationId, t.data.requested_by).userIds.includes(a.userId)
        )
          throw Error(
            "Only the assigned Cluster Manager/AOM may decide training; self-approval is blocked.",
          );
      }
      clean.push(item);
    }
    const result = await supabaseAdmin.rpc(
      p.scope === "daily"
        ? p.preview === true
          ? "validate_daily_id_usage_batch"
          : "save_daily_id_usage_batch"
        : "save_workforce_worked_id_batch",
      {
        p_company: a.companyId,
        p_actor: a.userId,
        p_entries: clean,
      },
    );
    if (result.error) throw Error(result.error.message);
    if (p.scope === "daily" && p.preview === true)
      return Response.json(
        {
          validated: true,
          affectedCount: new Set(result.data.affected_workforce_ids || []).size,
        },
        { headers },
      );
    let warning = "";
    try {
      const period = workedIdMonth(String(clean[0].date).slice(0, 7));
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
      { error: workedIdErrorMessage(e, "Review was not saved.") },
      { status: 400, headers },
    );
  }
}
