import { getAuthorization, hasPermission } from "@/lib/authorization";
import {
  cpsScope,
  loadCpsSnapshot,
  exportCpsAssociates,
} from "@/lib/ops-pulse/cps-data";
import {
  cpsView,
  cpsViews,
  cpsIssues,
  summarizeCps,
  groupCps,
  ratio,
  type CpsParams,
} from "@/lib/ops-pulse/cps";
import { compressedWorkbookResponse } from "@/lib/report-workbook";
import { adHocClusterLabel } from "@/lib/ops-pulse/adhoc-activity";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const summaryRow = (s: ReturnType<typeof summarizeCps>) => ({
  Deliveries: s.deliveries,
  Activity: s.activity,
  "Amazon deliveries": s.amazon,
  "SWA deliveries": s.swa,
  "C-return": s.returns,
  MFN: s.mfn,
  "MFN return": s.mfnReturn,
  "Associate-days": s.associateDays,
  "DA cost": s.da,
  "UTR cost": s.utr,
  "Van cost": s.van,
  "Other cost (includes rent)": s.other,
  "Rent included": s.rent,
  "Recorded cost": s.total,
  "Recorded CPS": s.cps,
  "Target CPS": s.target,
  "Over / under target": s.gap,
  "Cost impact (positive is over)": s.impact,
  Status: s.provisional ? "Provisional" : "Recorded",
  "Data gaps": cpsIssues(s).join("; "),
});
export async function GET(request: Request) {
  const auth = await getAuthorization();
  const params = Object.fromEntries(
    new URL(request.url).searchParams,
  ) as CpsParams;
  const view = cpsView(params.view);
  if (
    !auth ||
    !hasPermission(auth, "cps_reports", "access") ||
    !hasPermission(auth, cpsViews[view].permission, "access")
  )
    return Response.json(
      { error: "CPS report and selected-view access are required." },
      { status: 403, headers },
    );
  try {
    const scope = await cpsScope(auth, params);
    if (!scope.selected.length)
      return Response.json(
        { error: "No permitted locations match these filters." },
        { status: 403, headers },
      );
    const result = await loadCpsSnapshot(
      scope.companyId,
      scope.period.from,
      scope.period.to,
      scope.selected,
    );
    const places = new Map(scope.selected.map((l) => [l.station_code, l]));
    const deliveryByDay = new Map(
      result.daily.map((d) => [
        `${d.work_date}|${d.station_code}`,
        Number(d.deliveries),
      ]),
    );
    const people =
      view === "associates" || view === "unmapped"
        ? await exportCpsAssociates(
            scope.companyId,
            scope.period.from,
            scope.period.to,
            scope.selected.map((l) => l.station_code),
            view === "unmapped",
          )
        : null;
    return await compressedWorkbookResponse(
      [
        {
          name: "Summary",
          rows: [
            {
              From: scope.period.from,
              Through: scope.period.to,
              Period: scope.period.mode,
              "Generated at": result.generated_at,
              "Locations in scope": scope.selected.length,
              ...summaryRow(summarizeCps(result.daily)),
              Calculation:
                "Total recorded cost divided by delivered shipments. Missing costs and shipment days are flagged. Not an average of CPS.",
              Sources:
                "Shipment payment mapping, fuel imports, Cashbook, approved Adhoc, Finance rent and CPS Inputs.",
            },
          ],
        },
        {
          name: "Station CPS",
          rows: groupCps(result.daily, (r) => r.station_code).map((s) => ({
            Location: s.key,
            Name: places.get(s.key)?.station_name || s.key,
            Cluster: adHocClusterLabel(places.get(s.key)!),
            Region: places.get(s.key)?.region || "Unassigned",
            ...summaryRow(s),
          })),
        },
        {
          name: "Daily CPS",
          rows: result.daily.map((d) => ({
            Date: d.work_date,
            Location: d.station_code,
            ...summaryRow(summarizeCps([d])),
          })),
        },
        {
          name: "Cost breakup",
          rows: result.breakup.map((l) => ({
            Date: l.work_date,
            Location: l.station_code,
            Head: l.head,
            Cost: l.sub_head,
            Source: l.source,
            Amount: l.amount,
            "CPS contribution": ratio(
              Number(l.amount),
              deliveryByDay.get(`${l.work_date}|${l.station_code}`) ?? 0,
            ),
          })),
        },
        ...(people
          ? [
              {
                name: view === "unmapped" ? "Unmapped IDs" : "Associates",
                rows: people.map((r) => ({
                  Date: r.work_date,
                  Location: r.station_code,
                  "Provider ID": r.provider_employee_id,
                  Name: r.dropx_name || r.provider_employee_name,
                  "Pay scheme": r.pay_type,
                  Deliveries: r.total_delivery,
                  "C-return": r.c_return,
                  MFN: r.mfn,
                  "MFN return": r.mfn_return,
                  "Variable pay":
                    r.mapping_status === "Mapped" ? r.variable_pay : null,
                  "MG or salary":
                    r.mapping_status === "Mapped" ? r.mg_pay : null,
                  "Fuel pay": r.mapping_status === "Mapped" ? r.fuel_pay : null,
                  "Total pay":
                    r.mapping_status === "Mapped" ? r.da_total_pay : null,
                  "Payment setup": r.mapping_status,
                })),
              },
            ]
          : []),
      ],
      `cps-${scope.period.mode}-${scope.period.from}-to-${scope.period.to}.xlsx`,
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "CPS export failed. Please retry.",
      },
      { status: 503, headers },
    );
  }
}
