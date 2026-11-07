import "server-only";
import { supabaseAdmin } from "./supabase-admin";
import { readAllRows } from "./supabase-pagination";
import {
  workedIdCounts,
  workedIdKey,
  workedIdDeliveryRoles,
  hasWorkedIdFixedSalary,
} from "./worked-id-review";
import { workedIdTrainingRouting } from "./worked-id-training-routing";
import {
  normalizePayoutIdentity,
  resolveShipmentPayoutMapping,
} from "./workforce-payout-population";
export async function loadWorkedIdReview(
  company: string,
  stationIds: string[],
  from: string,
  to: string,
  viewerId: string,
  evidenceWorker?: string,
) {
  if (!supabaseAdmin) throw Error("Database is unavailable.");
  const db = supabaseAdmin;
  const st = await db
    .from("stations")
    .select("id,station_code,station_name,region,cluster")
    .eq("company_id", company)
    .in("id", stationIds);
  if (st.error || st.data.length !== stationIds.length)
    throw Error("Location unavailable.");
  const selectedStations = new Map(st.data.map((s) => [s.id, s]));
  const selectedCodes = st.data.map((s) => s.station_code);
  const results = await Promise.all([
    readAllRows(
      db
        .from("workforce")
        .select(
          "id,source_profile_id,full_name,dropx_id,created_at,date_of_join,last_working_date,designation,location_id,designations(code,name)",
        )
        .eq("company_id", company)
        .order("id"),
    ),
    readAllRows(
      db
        .from("field_executive_provider_mappings")
        .select(
          "id,workforce_id,employee_id,contractor_id,field_executive_id,provider_member_id,station_id,effective_from,effective_to,payment_values,production_threshold_config,providers(code,name),payment_methods(name,payment_method_components(component_code,label,component_type,pay_schedule,is_active))",
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
        .in("location_id", stationIds)
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
        .in("station_code", selectedCodes)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("id"),
    ),
    readAllRows(
      db
        .from("workforce_worked_id_reviews")
        .select("*,workforce_worked_id_shares(*)")
        .eq("company_id", company)
        .in("station_id", stationIds)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("id"),
    ),
    readAllRows(
      db
        .from("workforce_payment_allocations")
        .select(
          "workforce_id,station_id,effective_from,effective_to,payment_values,payment_components,payment_methods(name)",
        )
        .eq("company_id", company)
        .in("station_id", stationIds)
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
    hasWorkedIdFixedSalary(
      first(m.payment_methods)?.payment_method_components || [],
      m.payment_values || {},
    );
  const rows = new Map<string, any>();
  const reportDays = new Set(
    shipments.map((s) => `${s.station_code}|${s.work_date}`),
  );
  for (const p of punches) {
    let w = wm.get(
      p.account_id || p.field_executive_id || p.contractor_id || p.employee_id,
    );
    if (
      !w ||
      !workedIdDeliveryRoles.includes(
        first(w.designations)?.code || w.designation,
      ) ||
      (w.date_of_join && p.punch_date < w.date_of_join) ||
      (w.last_working_date && p.punch_date > w.last_working_date)
    )
      continue;
    const stationId = p.location_id;
    const location = selectedStations.get(stationId)!;
    const dayKey = workedIdKey(w.id, p.punch_date);
    let k = `${stationId}|${dayKey}`,
      r = rows.get(k) || {
        key: k,
        workerId: w.id,
        stationId,
        stationCode: location.station_code,
        stationName: location.station_name,
        region: location.region || "Unassigned",
        cluster: location.cluster || "Unassigned",
        name: w.full_name,
        dropxId: w.dropx_id,
        role: first(w.designations)?.name || w.designation,
        date: p.punch_date,
        punches: 0,
        punchTimes: [],
        registeredAt: w.created_at,
        ownDeliveries: ownDelivery.get(dayKey) || 0,
        hasStationDeliveryData: reportDays.has(
          `${location.station_code}|${p.punch_date}`,
        ),
        payPlans: [
          ...mappings
            .filter(
              (m) =>
                m.station_id === stationId &&
                active(m, p.punch_date) &&
                wm.get(
                  m.workforce_id ||
                    m.contractor_id ||
                    m.employee_id ||
                    m.field_executive_id,
                )?.id === w.id,
            )
            .map((m) => ({
              name: first(m.payment_methods)?.name || "Mapped payment",
              providerId: m.provider_member_id,
              from: m.effective_from,
              to: m.effective_to,
              values: m.payment_values || {},
              components: (
                first(m.payment_methods)?.payment_method_components || []
              )
                .filter((c: any) => c.is_active)
                .map((c: any) => ({
                  code: c.component_code,
                  label: c.label,
                  type: c.component_type,
                  schedule: c.pay_schedule,
                })),
              threshold: m.production_threshold_config,
            })),
          ...allocations
            .filter(
              (a) =>
                a.workforce_id === w.id &&
                a.station_id === stationId &&
                active(a, p.punch_date),
            )
            .map((a) => ({
              name: first(a.payment_methods)?.name || "Direct workforce pay",
              providerId: null,
              from: a.effective_from,
              to: a.effective_to,
              values: a.payment_values || {},
              components: (a.payment_components || []).map((c: any) => ({
                code: c.code || c.component_code,
                label: c.label,
                type: c.type || c.component_type,
                schedule: c.schedule || c.pay_schedule,
              })),
            })),
        ],
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
            (a) =>
              a.workforce_id === w.id &&
              a.station_id === stationId &&
              active(a, p.punch_date) &&
              hasWorkedIdFixedSalary(
                a.payment_components || [],
                a.payment_values || {},
              ),
          ),
        decision: "pending",
        version: 0,
        reason: "",
        shares: [],
      };
    r.punches++;
    r.punchTimes.push(p.punch_time);
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
    const k = `${review.station_id}|${workedIdKey(review.workforce_id, review.work_date)}`,
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
  for (const r of rows.values()) {
    r.ownerAbsenceNeedsReview = r.shares.some(
      (s: any) => s.owner_worked === false && !s.owner_absence_confirmed,
    );
    const elsewhere = reviews.find(
      (v) =>
        v.workforce_id === r.workerId &&
        v.work_date === r.date &&
        v.station_id !== r.stationId,
    );
    r.reviewElsewhere = elsewhere
      ? stationCodes.get(elsewhere.station_id)
      : null;
  }
  const sources = (evidenceWorker ? shipments : [])
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
        stationId: st.data.find((x) => x.station_code === s.station_code)?.id,
        counts: workedIdCounts(s),
        allocated,
        ownerId: owner?.id || "",
        ownerName: owner?.full_name || "Mapping unresolved",
        ownerDropxId: owner?.dropx_id || "",
        ownerPunches: owner
          ? punches.filter(
              (p) =>
                p.punch_date === s.work_date &&
                stationCodes.get(p.location_id) === s.station_code &&
                wm.get(
                  p.account_id ||
                    p.field_executive_id ||
                    p.contractor_id ||
                    p.employee_id,
                )?.id === owner.id,
            ).length
          : 0,
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
  const trainingResult = await readAllRows(
    db
      .from("workforce_buddy_training_requests")
      .select("*")
      .eq("company_id", company)
      .order("id"),
  );
  if (trainingResult.error) throw Error(trainingResult.error.message);
  const training = trainingResult.data || [];
  const route = await workedIdTrainingRouting(company, stationIds);
  for (const r of rows.values()) {
    const t = training.find(
      (x) =>
        x.workforce_id === r.workerId &&
        x.work_date === r.date &&
        x.station_id === r.stationId,
    );
    r.trainingUsed = training.filter(
      (x) =>
        x.workforce_id === r.workerId &&
        ["pending", "approved"].includes(x.status),
    ).length;
    const buddySource = sources.find((s) => s.id === t?.buddy_source_id);
    r.training = t
      ? {
          ...t,
          buddyName: buddySource?.ownerName,
          buddyDropxId: buddySource?.ownerDropxId,
          buddyProviderId: buddySource?.provider_employee_id,
          buddyDeliveries: buddySource?.counts.total_delivery,
          buddyPunches: buddySource?.ownerPunches,
          canApprove:
            t.status === "pending" &&
            t.requested_by !== viewerId &&
            t.approver_ids.includes(viewerId) &&
            route(r.stationId, t.requested_by).userIds.includes(viewerId),
        }
      : null;
    r.trainingRoute = route(r.stationId, viewerId).names;
    const registered = r.registeredAt
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Kolkata",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(r.registeredAt))
      : "";
    r.registeredDate = registered;
    r.trainingEligible =
      !!registered &&
      !!r.dropxId &&
      registered.slice(0, 7) === r.date.slice(0, 7) &&
      registered <= r.date &&
      r.trainingUsed < 2;
  }
  return {
    stations: st.data,
    rows: [...rows.values()]
      .filter(
        (r) =>
          (!evidenceWorker || r.workerId === evidenceWorker) &&
          r.hasPaySetup &&
          (r.ownDeliveries === 0 || r.decision !== "pending"),
      )
      .sort(
        (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
      )
      .map((r) =>
        evidenceWorker
          ? r
          : { ...r, payPlans: undefined, punchTimes: undefined },
      ),
    sources,
  };
}
