import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import { readAllRows } from "./supabase-pagination";
import { workedIdCounts, workedIdKey } from "./worked-id-review";
import {
  normalizePayoutIdentity,
  resolveShipmentPayoutMapping,
} from "./workforce-payout-population";
export async function loadWorkedIdReview(
  company: string,
  stationId: string,
  from: string,
  to: string,
) {
  if (!supabaseAdmin) throw Error("Database is unavailable.");
  const db = supabaseAdmin;
  const st = await db
    .from("stations")
    .select("id,station_code,station_name")
    .eq("company_id", company)
    .eq("id", stationId)
    .single();
  if (st.error) throw Error("Location unavailable.");
  const results = await Promise.all([
    readAllRows(
      db
        .from("workforce")
        .select(
          "id,source_profile_id,full_name,dropx_id,date_of_join,last_working_date,designation,location_id",
        )
        .eq("company_id", company)
        .order("id"),
    ),
    readAllRows(
      db
        .from("field_executive_provider_mappings")
        .select(
          "id,workforce_id,employee_id,contractor_id,field_executive_id,provider_member_id,station_id,effective_from,effective_to,payment_values,providers(code,name),payment_methods(name,payment_method_components(component_type,pay_schedule,is_active))",
        )
        .eq("company_id", company)
        .in("status", ["active", "closed"])
        .lte("effective_from", to)
        .or(`effective_to.is.null,effective_to.gte.${from}`)
        .order("id"),
    ),
    readAllRows(
      db
        .from("attendance_punches")
        .select(
          "id,account_id,employee_id,contractor_id,field_executive_id,punch_date,punch_time,location_id",
        )
        .eq("company_id", company)
        .eq("source", "biometric")
        .eq("location_id", stationId)
        .gte("punch_date", from)
        .lte("punch_date", to)
        .order("id"),
    ),
    readAllRows(
      db
        .from("cps_shipment_daily")
        .select(
          "id,work_date,station_code,client,provider_employee_id,provider_employee_name,amazon_delivery,swa_delivery,total_delivery,c_return,mfn,mfn_return,assigned_count,delivery_assigned_count,pickup_assigned_count",
        )
        .eq("company_id", company)
        .eq("station_code", st.data.station_code)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("id"),
    ),
    readAllRows(
      db
        .from("workforce_worked_id_reviews")
        .select("*,workforce_worked_id_shares(*)")
        .eq("company_id", company)
        .eq("station_id", stationId)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("id"),
    ),
    readAllRows(
      db
        .from("workforce_payment_allocations")
        .select("workforce_id,effective_from,effective_to")
        .eq("company_id", company)
        .eq("station_id", stationId)
        .in("status", ["active", "closed"])
        .lte("effective_from", to)
        .or(`effective_to.is.null,effective_to.gte.${from}`)
        .order("id"),
    ),
    readAllRows(
      db
        .from("stations")
        .select("id,station_code")
        .eq("company_id", company)
        .order("id"),
    ),
  ]);
  for (const r of results) if (r.error) throw Error(r.error.message);
  const [
    workers,
    mappings,
    punches,
    shipments,
    reviews,
    allocations,
    stations,
  ] = results.map((r) => r.data ?? []) as any[][];
  const first = (x: any) => (Array.isArray(x) ? x[0] : x);
  const wm = new Map<string, any>();
  for (const w of workers)
    for (const id of [w.id, w.source_profile_id].filter(Boolean)) wm.set(id, w);
  const stationCodes = new Map(stations.map((s) => [s.id, s.station_code]));
  const active = (m: any, d: string) =>
    m.effective_from <= d && (!m.effective_to || m.effective_to >= d);
  const mids = mappings.map((m) => ({
    id: m.id,
    workforceId:
      wm.get(
        m.workforce_id ||
          m.contractor_id ||
          m.employee_id ||
          m.field_executive_id,
      )?.id || "",
    stationCode: stationCodes.get(m.station_id) || "",
    providerIdentity: `${first(m.providers)?.code} ${first(m.providers)?.name}`,
    providerMemberId: m.provider_member_id,
    effectiveFrom: m.effective_from,
    effectiveTo: m.effective_to,
    paymentMethodId: "",
  }));
  const byId = new Map<string, typeof mids>();
  for (const m of mids) {
    let k = normalizePayoutIdentity(m.providerMemberId);
    byId.set(k, [...(byId.get(k) || []), m]);
  }
  const resolve = (s: any) =>
    resolveShipmentPayoutMapping(
      s,
      byId.get(normalizePayoutIdentity(s.provider_employee_id)) || [],
    );
  // Check the candidate's IDs across stations privately. A transfer or report station
  // mismatch must not manufacture a "no delivery" attendance exception.
  const candidateIds = new Set(
    punches
      .map(
        (p) =>
          wm.get(
            p.account_id ||
              p.field_executive_id ||
              p.contractor_id ||
              p.employee_id,
          )?.id,
      )
      .filter(Boolean),
  );
  const memberIds = [
    ...new Set(
      mids
        .filter((m) => candidateIds.has(m.workforceId))
        .map((m) => m.providerMemberId),
    ),
  ];
  const evidence: any[] = [];
  for (let i = 0; i < memberIds.length; i += 100) {
    const result = await readAllRows(
      db
        .from("cps_shipment_daily")
        .select(
          "provider_employee_id,work_date,client,station_code,total_delivery",
        )
        .eq("company_id", company)
        .in("provider_employee_id", memberIds.slice(i, i + 100))
        .gte("work_date", from)
        .lte("work_date", to)
        .order("id"),
    );
    if (result.error) throw Error(result.error.message);
    evidence.push(...(result.data || []));
  }
  const ownDelivery = new Map<string, number>();
  for (const s of evidence) {
    let a = resolve(s);
    if (a.kind === "unmapped") {
      const matches = (
        byId.get(normalizePayoutIdentity(s.provider_employee_id)) || []
      ).filter(
        (m) =>
          m.effectiveFrom <= s.work_date &&
          (!m.effectiveTo || m.effectiveTo >= s.work_date) &&
          normalizePayoutIdentity(m.providerIdentity).includes(
            normalizePayoutIdentity(s.client),
          ),
      );
      const owners = [...new Set(matches.map((m) => m.workforceId))];
      if (owners.length === 1)
        a = { kind: "mapped", workforceId: owners[0], matches };
    }
    if (a.kind === "mapped")
      ownDelivery.set(
        workedIdKey(a.workforceId, s.work_date),
        (ownDelivery.get(workedIdKey(a.workforceId, s.work_date)) || 0) +
          Number(s.total_delivery || 0),
      );
  }
  const fixed = (m: any) =>
    (first(m.payment_methods)?.payment_method_components || []).some(
      (c: any) =>
        c.is_active &&
        c.component_type === "amount" &&
        ["per_day", "per_month", "per_hour"].includes(c.pay_schedule),
    );
  const rows = new Map<string, any>();
  for (const p of punches) {
    let w = wm.get(
      p.account_id || p.field_executive_id || p.contractor_id || p.employee_id,
    );
    if (
      !w ||
      (w.date_of_join && p.punch_date < w.date_of_join) ||
      (w.last_working_date && p.punch_date > w.last_working_date)
    )
      continue;
    let k = workedIdKey(w.id, p.punch_date),
      r = rows.get(k) || {
        key: k,
        workerId: w.id,
        name: w.full_name,
        dropxId: w.dropx_id,
        role: w.designation,
        date: p.punch_date,
        punches: 0,
        ownDeliveries: ownDelivery.get(k) || 0,
        providerIds: mappings
          .filter(
            (m) =>
              wm.get(
                m.workforce_id ||
                  m.contractor_id ||
                  m.employee_id ||
                  m.field_executive_id,
              )?.id === w.id && active(m, p.punch_date),
          )
          .map((m) => m.provider_member_id),
        hasPaySetup:
          mappings.some(
            (m) =>
              fixed(m) &&
              m.station_id === stationId &&
              wm.get(
                m.workforce_id ||
                  m.contractor_id ||
                  m.employee_id ||
                  m.field_executive_id,
              )?.id === w.id &&
              active(m, p.punch_date),
          ) ||
          allocations.some(
            (a) => a.workforce_id === w.id && active(a, p.punch_date),
          ),
        decision: "pending",
        version: 0,
        reason: "",
        shares: [],
      };
    r.punches++;
    rows.set(k, r);
  }
  const reviewerIds = [...new Set(reviews.map((r) => r.updated_by))],
    reviewers = new Map<string, string>();
  for (let i = 0; i < reviewerIds.length; i += 100) {
    const result = await db
      .from("profiles")
      .select("id,full_name")
      .eq("company_id", company)
      .in("id", reviewerIds.slice(i, i + 100));
    if (result.error) throw Error(result.error.message);
    for (const p of result.data || []) reviewers.set(p.id, p.full_name || p.id);
  }
  for (const review of reviews) {
    const k = workedIdKey(review.workforce_id, review.work_date),
      r = rows.get(k);
    if (r)
      Object.assign(r, {
        decision: review.decision,
        version: review.version,
        reason: review.reason,
        reviewId: review.id,
        updatedAt: review.updated_at,
        updatedBy: reviewers.get(review.updated_by) || review.updated_by,
        shares: review.workforce_worked_id_shares || [],
      });
  }
  const shares = reviews
    .filter((r) => r.decision === "worked")
    .flatMap((r) => r.workforce_worked_id_shares || []);
  const sources = shipments
    .filter((s) => Number(s.total_delivery) > 0)
    .map((s) => {
      const rr = resolve(s),
        owner = wm.get(rr.workforceId);
      const sourceMappings = rr.matches.map((m) =>
        mappings.find((x) => x.id === m.id),
      );
      const allocated = workedIdCounts({});
      for (const a of shares.filter((a) => a.source_shipment_id === s.id))
        for (const k of Object.keys(allocated))
          allocated[k as keyof typeof allocated] += Number(
            a.quantities[k] || 0,
          );
      return {
        ...s,
        counts: workedIdCounts(s),
        allocated,
        ownerId: owner?.id || "",
        ownerName: owner?.full_name || "Mapping unresolved",
        ownerDropxId: owner?.dropx_id || "",
        payMethod: [
          ...new Set(
            sourceMappings.map(
              (m) => first(m?.payment_methods)?.name || "Not configured",
            ),
          ),
        ].join(", "),
        rates: sourceMappings.map((m) => m?.payment_values || {}),
        mappingIssue: rr.kind !== "mapped",
      };
    });
  return {
    station: st.data,
    rows: [...rows.values()]
      .filter(
        (r) =>
          (r.hasPaySetup && r.ownDeliveries === 0) || r.decision !== "pending",
      )
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
      ),
    sources,
  };
}
