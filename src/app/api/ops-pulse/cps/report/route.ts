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
  cpsStationGroups,
  ratio,
  type CpsParams,
} from "@/lib/ops-pulse/cps";
import { compressedWorkbookResponse } from "@/lib/report-workbook";
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
  "Other cost (incl rent & overhead)": s.other+s.rent+s.overhead,
  "DA CPS": ratio(s.da,s.deliveries),
  "UTR CPS": ratio(s.utr,s.deliveries),
  "Van CPS": ratio(s.van,s.deliveries),
  "Other CPS": ratio(s.other+s.rent+s.overhead,s.deliveries),
  "Rent": s.rent,
  "Overhead": s.overhead,
  "DA salary": s.salary,
  "DA variable": s.variable,
  "DA fuel": s.fuel,
  "DA salary CPS": ratio(s.salary,s.deliveries),
  "Uncosted deliveries": s.exposedDeliveries,
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
    const scope = await cpsScope(auth, params, true);
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
    const groups = cpsStationGroups(scope.selected.map(l => ({ code: l.station_code, name: l.station_name || l.station_code, parent: l.parent_station_code, isXpt: l.is_xpt })));
    const byGroup = new Map(groups.map(g => [g.code, g]));
    const groupByMember = new Map(groups.flatMap(g => g.members.map(code => [code, g.code] as const)));
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
              "Allocation notices": (result.allocation_notices??[]).join("; "),
              Calculation:
                "EDSP + authorized XPT costs and delivered shipments combined once under their parent. Total recorded cost divided by delivered shipments. Missing costs and shipment days are flagged. Not an average of CPS.",
              Sources:
                "People CTC, live workforce rate cards, daily shipments, fuel imports, Cashbook, approved operating payments, Finance rent, Fleet vehicle rent and cost setup.",
            },
          ],
        },
        {
          name: "Station CPS",
          rows: groupCps(result.daily, r => groupByMember.get(r.station_code) || r.station_code).map((s) => ({
            Location: s.key,
            Name: byGroup.get(s.key)?.name || s.key,
            "Included stations": byGroup.get(s.key)?.members.join(", ") || s.key,
            "Group scope": byGroup.get(s.key)?.subtitle || "Station",
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
        {name:"Staff cost allocation",rows:(result.staff??[]).map(p=>({Group:p.group,Station:p.station_code,Head:p.head,From:p.from_date,Through:p.through_date,Allocation:p.allocation,"Period cost":p.amount}))},
        {name:"Bill periods",rows:result.expense_periods??[]},
        {name:"Vehicle rent",rows:(result.vehicles??[]).map(v=>({Vehicle:v.vehicle_no,Model:v.model,Station:v.station_code,"Monthly rent":v.monthly_rent,From:v.from_date,Through:v.through_date,"Deployed days":v.days,"Period rent":v.amount,Status:v.monthly_rent==null?'Setup required':'Configured'}))},
        ...(result.gaps ? [{name:"Needs attention",rows:result.gaps.map(g=>({Issue:g.kind,Owner:g.owner,Station:g.station_code,"DropX ID":g.dropx_id,"Provider ID":g.provider_id,Name:g.name,"First seen":g.first_date,Through:g.last_date,Days:g.days,"Affected deliveries":g.deliveries,Action:g.href}))}] : []),
        ...(result.people ? [{name:"DA productivity",rows:result.people.map(p=>({"DropX ID":p.dropx_id,Name:p.name,Station:p.station_code,Deliveries:p.deliveries,"Fixed pay":p.salary,"Variable pay":p.variable,"DA fuel":p.fuel,"Van cost":p.van,"Salary CPS":ratio(p.salary,p.deliveries),"Paid days":p.paid_days,"Zero delivery paid days":p.zero_delivery_days}))}] : []),
        ...(people
          ? [
              {
                name: view === "unmapped" ? "Unmapped IDs" : "Associates",
                rows: people.map((r) => ({
                  Date: r.work_date,
                  Location: r.station_code,
                  "Provider ID": r.provider_employee_id,
                  "DropX ID": r.dropx_emp_code,
                  "Van pay": r.van_pay,
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
