import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  loadPerformanceTargets,
  resolvePerformanceTargets,
} from "./performance-targets";
import { ACTIVE_DAILY_PERFORMANCE_SOURCE } from "./performance-source-policy";
import { loadStationReviewTargets } from "./station-review-targets-data";
import { loadStationOpeningAttendance } from "./station-opening-attendance";
import {
  isAdHocHead,
  adHocCategory,
  isApprovedPayment,
  paymentReason,
} from "./performance-review";
import {
  clockMinutes,
  costTrendSeries,
  performanceTrendSeries,
  trendDates,
  trendNumber,
  type TrendGroup,
  type TrendResponse,
  type TrendRow,
  type TrendSeries,
} from "./review-trends";

export async function readTrendPages(
  query: (
    offset: number,
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
) {
  const rows: TrendRow[] = [];
  for (let offset = 0; offset < 30000; offset += 1000) {
    const result = await query(offset);
    if (result.error)
      throw Error("Trend data could not be loaded. Please retry.");
    const page = (result.data ?? []) as TrendRow[];
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
  throw Error("Too much source data to load safely. Please contact support.");
}
export async function loadReviewTrends(
  companyId: string,
  station: { id: string; station_code: string },
  endDate: string,
  group: TrendGroup,
): Promise<TrendResponse> {
  if (!supabaseAdmin) throw Error("Trend data is temporarily unavailable.");
  const db = supabaseAdmin,
    dates = trendDates(
      endDate,
      group === "cost" ? Math.max(14, Number(endDate.slice(8, 10))) : 14,
    ),
    from = dates[0],
    code = station.station_code;
  let series: TrendSeries[] = [];
  if (group === "performance") {
    const [facts, targets] = await Promise.all([
      readTrendPages((offset) =>
        db
          .from("report_metric_facts")
          .select("id,batch_id,source_type,report_date,values_json,created_at")
          .eq("company_id", companyId)
          .eq("station_code", code)
          .eq("source_type", ACTIVE_DAILY_PERFORMANCE_SOURCE)
          .gte("report_date", from)
          .lte("report_date", endDate)
          .order("created_at", { ascending: false })
          .order("id")
          .range(offset, offset + 999),
      ),
      loadPerformanceTargets(companyId, { readOnly: true }),
    ]);
    if (targets.error)
      throw Error("Trend targets could not be loaded. Please retry.");
    series = performanceTrendSeries(
      dates,
      facts,
      resolvePerformanceTargets(targets.rows, "daily"),
    );
  } else if (group === "cost") {
    const monthFrom = `${from.slice(0, 7)}-01`;
    const [costs, capacity, shipments, heads] = await Promise.all([
      readTrendPages((offset) =>
        db
          .from("cps_station_daily")
          .select(
            "work_date,total_delivery,total_cost,overall_cps,da_pay_cost,da_cps",
          )
          .eq("company_id", companyId)
          .eq("station_code", code)
          .gte("work_date", monthFrom)
          .lte("work_date", endDate)
          .order("work_date")
          .order("id")
          .range(offset, offset + 999),
      ),
      readTrendPages((offset) =>
        db
          .from("capacity_station_daily_cache")
          .select("work_date,delivered,active_ids")
          .eq("company_id", companyId)
          .eq("station_code", code)
          .gte("work_date", monthFrom)
          .lte("work_date", endDate)
          .order("work_date")
          .range(offset, offset + 999),
      ),
      readTrendPages((offset) =>
        db
          .from("cps_shipment_daily")
          .select(
            "work_date,provider_employee_id,total_delivery,da_total_pay,mapping_status",
          )
          .eq("company_id", companyId)
          .eq("station_code", code)
          .gte("work_date", from)
          .lte("work_date", endDate)
          .order("work_date")
          .order("id")
          .range(offset, offset + 999),
      ),
      db
        .from("payment_heads")
        .select("id,code,name")
        .eq("company_id", companyId),
    ]);
    if (heads.error)
      throw Error("Payment categories could not be loaded. Please retry.");
    const detailDates = dates.filter((date) => {
      const row = capacity.find((r) => r.work_date === date);
      return !trendNumber(row?.delivered) || !trendNumber(row?.active_ids);
    });
    const details = detailDates.length
      ? await readTrendPages((offset) =>
          db
            .from("delivered_shipment_facts")
            .select("work_date,driver_id,driver_name,package_count")
            .eq("company_id", companyId)
            .eq("station_code", code)
            .in("work_date", detailDates)
            .order("work_date")
            .order("id")
            .range(offset, offset + 999),
        )
      : [];
    const selectedHeads = (heads.data ?? []).filter(isAdHocHead),
      headMap = new Map(selectedHeads.map((h) => [h.id, h]));
    // Station restriction is applied in the query, not just to the returned chart.
    const payments = selectedHeads.length
      ? await readTrendPages((offset) =>
          db
            .from("payment_requests")
            .select(
              "id,request_no,work_date,payment_head_id,amount,amount_approved,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id,remarks,notes,details,payment_request_answers(answer_value,payment_head_questions(question_text))",
            )
            .eq("company_id", companyId)
            .or(
              `station_code.eq.${code},and(station_code.is.null,location_code.eq.${code})`,
            )
            .in(
              "payment_head_id",
              selectedHeads.map((h) => h.id),
            )
            .gte("work_date", monthFrom)
            .lte("work_date", endDate)
            .order("work_date")
            .order("id")
            .range(offset, offset + 999),
        )
      : [];
    const approved = payments
      .filter((row) =>
        isApprovedPayment(row as Parameters<typeof isApprovedPayment>[0]),
      )
      .map((row) => ({
        ...row,
        category: adHocCategory(
          headMap.get(String(row.payment_head_id)) ?? {
            code: null,
            name: null,
          },
        ),
        approved_amount:
          trendNumber(row.amount_approved) ??
          trendNumber(row.amount) ??
          trendNumber(row.amount_requested),
        request_reason: paymentReason(row),
        request_remarks: String(row.remarks ?? row.notes ?? "").trim(),
        request_fields: [
          ...(Array.isArray(row.payment_request_answers)
            ? row.payment_request_answers
            : []
          ).flatMap((answer) => {
            if (!answer || typeof answer !== "object") return [];
            const value = String((answer as Record<string, unknown>).answer_value ?? "").trim(),
              relation = (answer as Record<string, unknown>).payment_head_questions,
              question = Array.isArray(relation) ? relation[0] : relation,
              label = question && typeof question === "object"
                ? String((question as Record<string, unknown>).question_text ?? "").trim()
                : "";
            if (!label || !value) return [];
            const normalized = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
            return /(REASON|REMARK|PURPOSE|DESCRIPTION|DEPLOYMENT|ROUTE|TRIP|VEHICLE|VAN|SHIPMENT|PACKAGE|PARCEL|VOLUME|VENDOR)/.test(normalized)
              ? [{ label, value }]
              : [];
          }),
          ...(row.details && typeof row.details === "object" && !Array.isArray(row.details)
            ? Object.entries(row.details as Record<string, unknown>).flatMap(([key, rawValue]) => {
                const normalized = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
                  value = String(rawValue ?? "").trim();
                if (!value || !/(REASON|REMARK|PURPOSE|DESCRIPTION|DEPLOYMENT|ROUTE|TRIP|VEHICLE|VAN|SHIPMENT|PACKAGE|PARCEL|VOLUME|VENDOR)/.test(normalized)) return [];
                return [{
                  label: key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
                  value,
                }];
              })
            : []),
        ],
      }));
    if (approved.some((row) => row.approved_amount == null))
      throw Error(
        "An approved request has no valid amount. Please check its payment details.",
      );
    series = costTrendSeries(
      dates,
      costs,
      capacity,
      shipments,
      approved,
      details,
    );
  } else if (group === "station") {
    const [inputs, connections, targetResult] = await Promise.all([
      readTrendPages((offset) =>
        db
          .from("ops_performance_daily_inputs")
          .select("source_date,emd_noon_pct")
          .eq("company_id", companyId)
          .eq("station_id", station.id)
          .gte("source_date", from)
          .lte("source_date", endDate)
          .order("source_date")
          .range(offset, offset + 999),
      ),
      readTrendPages((offset) =>
        db
          .from("ops_performance_connections")
          .select("service_date,arrival_at,unloading_at,clearance_at")
          .eq("company_id", companyId)
          .eq("station_id", station.id)
          .gte("service_date", from)
          .lte("service_date", endDate)
          .order("service_date")
          .order("id")
          .range(offset, offset + 999),
      ),
      loadStationReviewTargets(companyId, [station.id]),
    ]);
    if (targetResult.error) throw Error(targetResult.error);
    const targets = targetResult.rows[0]?.targets;
    series = [
      {
        key: "emd",
        label: "EMD at 12 p.m.",
        unit: "percent",
        target: targets?.emdNoonTarget,
        direction: "higher",
        note: "Saved station-level noon EMD. Target line uses the current station setting.",
        points: dates.map((date) => ({
          date,
          value: trendNumber(
            inputs.find((row) => row.source_date === date)?.emd_noon_pct,
          ),
        })),
      },
    ];
    for (const [key, label, column] of [
      ["arrival", "First vehicle arrival", "arrival_at"],
      ["unloading", "Last unloading complete", "unloading_at"],
      ["clearance", "Last station clearance", "clearance_at"],
    ]) {
      const cutoff = targets?.clearanceCutoff?.split(":").map(Number);
      series.push({
        key,
        label,
        unit: "time",
        target:
          key === "clearance" && cutoff ? cutoff[0] * 60 + cutoff[1] : null,
        direction: "lower",
        note: "All saved vehicles for each service date. +1d indicates an overnight completion. Missing timings remain gaps.",
        points: dates.map((date) => {
          const rows = connections.filter((row) => row.service_date === date),
            values = rows.flatMap((row) => {
              const v = clockMinutes(row[column], date);
              return v == null ? [] : [v];
            });
          return {
            date,
            value: values.length
              ? key === "arrival"
                ? Math.min(...values)
                : Math.max(...values)
              : null,
            note: `${rows.length} vehicles · ${values.length} timings recorded`,
          };
        }),
      });
    }
  } else {
    const settings = await db
      .from("ops_performance_station_settings")
      .select("opening_window_start,opening_window_end")
      .eq("company_id", companyId)
      .eq("station_id", station.id)
      .maybeSingle();
    if (settings.error)
      throw Error("Station opening settings could not be loaded.");
    const windows = new Map([
      [
        station.id,
        {
          start: String(settings.data?.opening_window_start ?? "02:00:00"),
          end: String(settings.data?.opening_window_end ?? "10:00:00"),
        },
      ],
    ]);
    const points: TrendSeries["points"] = [];
    // Reuse the canonical People opening logic; bounded concurrency protects attendance services.
    for (let index = 0; index < dates.length; index += 2)
      points.push(
        ...(await Promise.all(
          dates.slice(index, index + 2).map(async (date) => {
            const openings = await loadStationOpeningAttendance(
                companyId,
                date,
                [station],
                windows,
              ),
              punch = openings.get(station.id)?.peoplePunch;
            return {
              date,
              value: clockMinutes(punch?.time),
              note: punch
                ? "First valid People IN punch"
                : "No valid People opening punch",
            };
          }),
        )),
      );
    series = [
      {
        key: "opening",
        label: "Station opening time",
        unit: "time",
        points,
        note: "Same People IN-punch and physical-station rules as the opening card. OUT punches and non-People profiles do not count. IST; current station opening window applies.",
      },
    ];
  }
  return { station: code, endDate, series };
}
