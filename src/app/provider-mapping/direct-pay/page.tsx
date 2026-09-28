import Link from "next/link";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import {
  DirectPaymentAllocationWorksheet,
  type DirectPaymentAllocationRow
} from "@/components/direct-payment-allocation-worksheet";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import {
  directPaymentMethodEligible,
  type DirectPaymentComponent,
  type DirectPaymentMethod
} from "@/lib/workforce-payment-allocation";

type DesignationRow = { id: string; code: string; name: string };
type WorkforceRow = {
  id: string;
  dropx_id: string | null;
  full_name: string;
  location_id: string | null;
  designation_id: string | null;
  designation: string | null;
  date_of_join: string | null;
};
type AllocationRow = {
  id: string;
  workforce_id: string;
  payment_method_id: string;
  payment_values: Record<string, unknown> | null;
  effective_from: string;
  effective_to: string | null;
  status: string;
};
type PaymentMethodRow = {
  id: string;
  code: string;
  name: string;
  payment_method_components: Array<{
    component_code: string;
    component_type: "amount" | "production";
    label: string;
    pay_schedule: "per_hour" | "per_day" | "per_month" | null;
    sort_order: number;
    is_active: boolean;
  }> | null;
};

function loadFlash() {
  const raw = cookies().get("dropx_direct_payment_allocation_flash")?.value;
  try {
    return raw ? JSON.parse(raw) as { error?: string; notice?: string } : {};
  } catch {
    return {};
  }
}

function paymentMethods(rows: PaymentMethodRow[]) {
  return rows.map((method): DirectPaymentMethod => ({
    id: method.id,
    code: method.code,
    name: method.name,
    components: (method.payment_method_components ?? [])
      .filter((component) => component.is_active)
      .slice()
      .sort((first, second) => first.sort_order - second.sort_order)
      .map((component): DirectPaymentComponent => ({
        code: component.component_code,
        label: component.label,
        type: component.component_type,
        schedule: component.pay_schedule,
        active: component.is_active
      }))
  }));
}

export const dynamic = "force-dynamic";

export default async function DirectPaymentAllocationsPage({
  searchParams = {}
}: {
  searchParams?: { q?: string };
}) {
  const authorization = await requirePagePermission("provider_mapping", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.provider_mapping;
  const canEdit = Boolean(permission?.canAdd || permission?.canEdit);
  const flash = loadFlash();

  if (!supabaseAdmin) {
    return <AppShell active="ID Mapping" pageCode="provider_mapping">
      <PageHead eyebrow="Direct workforce pay" title="Direct pay allocations" />
      <section className="panel message-panel error"><div className="panel-body"><strong>Action required</strong><p className="subtle">Supabase service role key is not configured.</p></div></section>
    </AppShell>;
  }

  const [designationResult, stationResult, methodResult] = await Promise.all([
    supabaseAdmin.from("designations")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("is_field_operations", true)
      .eq("provider_mapping_required", false)
      .order("code"),
    supabaseAdmin.from("stations")
      .select("id, station_code, station_name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code"),
    supabaseAdmin.from("payment_methods")
      .select("id, code, name, payment_method_components(component_code, component_type, label, pay_schedule, sort_order, is_active)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code")
  ]);

  let loadError: { message: string } | null = designationResult.error || stationResult.error || methodResult.error;
  const designations = (designationResult.data ?? []) as DesignationRow[];
  const designationById = new Map(designations.map((designation) => [designation.id, designation]));
  const designationByName = new Map(designations.flatMap((designation) => [designation.code, designation.name]
    .map((value) => [String(value).trim().toLowerCase(), designation] as const)));
  let workers: WorkforceRow[] = [];
  if (!loadError && designations.length) {
    const workerResult = await readAllRows(supabaseAdmin.from("workforce")
      .select("id, dropx_id, full_name, location_id, designation_id, designation, date_of_join")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("dropx_id")
      .order("id"));
    loadError = workerResult.error;
    workers = ((workerResult.data ?? []) as WorkforceRow[]).filter((worker) => Boolean(
      designationById.get(String(worker.designation_id ?? ""))
      ?? designationByName.get(String(worker.designation ?? "").trim().toLowerCase())
    ));
  }

  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const allowedLocations = new Set(authorization.locationScopeIds);
  const activeStationIds = new Set((stationResult.data ?? []).map((station) => station.id));
  workers = workers.filter((worker) => Boolean(worker.location_id
    && activeStationIds.has(worker.location_id)
    && (allLocations || allowedLocations.has(worker.location_id))));

  let allocations: AllocationRow[] = [];
  if (!loadError && workers.length) {
    const allocationResult = await readAllRows(supabaseAdmin.from("workforce_payment_allocations")
      .select("id, workforce_id, payment_method_id, payment_values, effective_from, effective_to, status")
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id"));
    loadError = allocationResult.error;
    const workerIds = new Set(workers.map((worker) => worker.id));
    allocations = ((allocationResult.data ?? []) as AllocationRow[])
      .filter((allocation) => workerIds.has(allocation.workforce_id));
  }

  const allMethods = paymentMethods((methodResult.data ?? []) as PaymentMethodRow[]);
  const eligibleMethods = allMethods.filter((method) => directPaymentMethodEligible(method.components));
  const productionMethodCount = allMethods.filter((method) => method.components.some((component) => component.type === "production")).length;
  const methodNameById = new Map(allMethods.map((method) => [method.id, `${method.code} - ${method.name}`]));
  const designationLabelById = new Map(designations.map((designation) => [designation.id, `${designation.code} - ${designation.name}`]));
  const stationById = new Map((stationResult.data ?? []).map((station) => [station.id,
    station.station_name && station.station_name !== station.station_code
      ? `${station.station_code} - ${station.station_name}`
      : station.station_code
  ]));
  const historyByWorkforce = new Map<string, AllocationRow[]>();
  allocations.forEach((allocation) => historyByWorkforce.set(allocation.workforce_id, [
    ...(historyByWorkforce.get(allocation.workforce_id) ?? []),
    allocation
  ]));
  const today = todayKolkata();
  const rows: DirectPaymentAllocationRow[] = workers.map((worker) => {
    const history = historyByWorkforce.get(worker.id) ?? [];
    const current = history.find((allocation) => allocation.status !== "cancelled"
      && allocation.effective_from <= today
      && (!allocation.effective_to || allocation.effective_to >= today))
      ?? history.find((allocation) => allocation.status === "active" && !allocation.effective_to)
      ?? null;
    const defaultEffectiveFrom = worker.date_of_join && worker.date_of_join > today ? worker.date_of_join : today;
    return {
      workforceId: worker.id,
      dropxId: worker.dropx_id || "Not assigned",
      fullName: worker.full_name,
      stationLabel: stationById.get(worker.location_id ?? "") ?? "Location unavailable",
      designationLabel: designationLabelById.get(worker.designation_id ?? "")
        ?? (() => { const designation = designationByName.get(String(worker.designation ?? "").trim().toLowerCase()); return designation ? `${designation.code} - ${designation.name}` : "Designation unavailable"; })(),
      dateOfJoin: worker.date_of_join ?? "",
      allocationId: current?.id ?? "",
      paymentMethodId: current?.payment_method_id ?? "",
      currentMethodName: methodNameById.get(current?.payment_method_id ?? "") ?? "",
      paymentValues: Object.fromEntries(Object.entries(current?.payment_values ?? {})
        .map(([code, value]) => [code, Number(value)])
        .filter(([, value]) => Number.isFinite(value))),
      effectiveFrom: current
        ? (current.effective_from > today ? current.effective_from : today)
        : defaultEffectiveFrom,
      effectiveTo: current?.effective_to ?? "",
      historyCount: history.length
    };
  });

  const migrationMissing = loadError?.message?.includes("workforce_payment_allocations")
    || loadError?.message?.includes("provider_mapping_required");

  return <AppShell active="ID Mapping" pageCode="provider_mapping">
    <PageHead
      eyebrow="Provider-independent workforce pay"
      subtitle="Assign attendance, workday or fixed-amount payment methods to Field Operations designations that do not require provider mapping."
      title="Direct pay allocations"
    />
    <nav aria-label="ID mapping views" className="performance-tabs">
      <Link href="/provider-mapping">Existing worksheet</Link>
      <Link href="/provider-mapping/provider-first">Provider member first</Link>
      <Link className="active" href="/provider-mapping/direct-pay">Direct pay allocations</Link>
    </nav>
    {loadError ? <section className="panel message-panel error"><div className="panel-body">
      <strong>{migrationMissing ? "Database update required" : "Unable to load direct pay allocations"}</strong>
      <p className="subtle">{migrationMissing ? "Apply the designation provider-mapping policy and workforce payment allocations migrations, then refresh this page." : loadError.message}</p>
    </div></section> : null}
    {flash.error || flash.notice ? <section className={`panel message-panel ${flash.error ? "error" : "success"}`}><div className="panel-body">
      <strong>{flash.error ? "Action required" : "Completed"}</strong>
      <p className="subtle">{flash.error ?? flash.notice}</p>
    </div></section> : null}
    {!loadError && !eligibleMethods.length ? <section className="panel message-panel"><div className="panel-body">
      <strong>Create a direct-pay payment method</strong>
      <p className="subtle">No active payment method contains only attendance, workday or fixed-amount fields. Production fields cannot be used here.</p>
      <Link className="button secondary compact" href="/master/payment-methods">Open Payment Methods</Link>
    </div></section> : null}
    {!loadError ? <DirectPaymentAllocationWorksheet canEdit={canEdit} initialQuery={searchParams.q} methods={eligibleMethods} productionMethodCount={productionMethodCount} rows={rows} /> : null}
  </AppShell>;
}
