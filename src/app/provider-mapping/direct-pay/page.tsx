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
import { currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { paymentAllocationHistoryRates, sortPaymentAllocationHistory } from "@/lib/payment-allocation-history";
import {
  directPaymentMethodEligible,
  type DirectPaymentComponent,
  type DirectPaymentMethod
} from "@/lib/workforce-payment-allocation";

type DesignationRow = { id: string; code: string; name: string };
type PersonRow = {
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
  person_id: string;
  station_id: string | null;
  payment_method_id: string;
  payment_values: Record<string, unknown> | null;
  payment_components: Array<{
    component_code?: string;
    code?: string;
    label?: string;
    sort_order?: number;
    sortOrder?: number;
  }> | null;
  effective_from: string;
  effective_to: string | null;
  status: string;
  change_reason: string | null;
};
type PaymentMethodRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
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
        active: component.is_active,
        sortOrder: component.sort_order
      }))
  }));
}

export const dynamic = "force-dynamic";

export default async function DirectPaymentAllocationsPage({
  searchParams = {}
}: {
  searchParams?: { audience?: string; q?: string };
}) {
  const audience = searchParams.audience === "helpers" ? "helpers" : "workforce";
  const pageCode = currentProviderMappingPageCode();
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions[pageCode];
  const canEdit = Boolean(permission?.canAdd || permission?.canEdit);
  const flash = loadFlash();

  if (!supabaseAdmin) {
    return <AppShell active="ID Mapping" pageCode={pageCode}>
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
      .select("id, code, name, is_active, payment_method_components(component_code, component_type, label, pay_schedule, sort_order, is_active)")
      .eq("company_id", companyId)
      .order("code")
  ]);

  let loadError: { message: string } | null = designationResult.error || stationResult.error || methodResult.error;
  const designations = (designationResult.data ?? []) as DesignationRow[];
  const designationById = new Map(designations.map((designation) => [designation.id, designation]));
  const designationByName = new Map(designations.flatMap((designation) => [designation.code, designation.name]
    .map((value) => [String(value).trim().toLowerCase(), designation] as const)));
  let people: PersonRow[] = [];
  if (!loadError && (audience === "helpers" || designations.length)) {
    const personResult = audience === "helpers"
      ? await readAllRows(supabaseAdmin.from("helpers")
        .select("id, dropx_id, full_name, location_id, designation, date_of_join")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("onboarding_status", "active")
        .order("dropx_id")
        .order("id"))
      : await readAllRows(supabaseAdmin.from("workforce")
        .select("id, dropx_id, full_name, location_id, designation_id, designation, date_of_join")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("dropx_id")
        .order("id"));
    loadError = personResult.error;
    people = ((personResult.data ?? []) as PersonRow[]).filter((person) => audience === "helpers" || Boolean(
      designationById.get(String(person.designation_id ?? ""))
      ?? designationByName.get(String(person.designation ?? "").trim().toLowerCase())
    ));
  }

  const allLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const allowedLocations = new Set(authorization.locationScopeIds);
  const activeStationIds = new Set((stationResult.data ?? []).map((station) => station.id));
  people = people.filter((person) => Boolean(person.location_id
    && activeStationIds.has(person.location_id)
    && (allLocations || allowedLocations.has(person.location_id))));

  let allocations: AllocationRow[] = [];
  if (!loadError && people.length) {
    const allocationResult = audience === "helpers"
      ? await readAllRows(supabaseAdmin.from("helper_payment_allocations")
        .select("id, helper_id, station_id, payment_method_id, payment_values, payment_components, effective_from, effective_to, status, change_reason")
        .eq("company_id", companyId)
        .neq("status", "cancelled")
        .order("effective_from", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id"))
      : await readAllRows(supabaseAdmin.from("workforce_payment_allocations")
        .select("id, workforce_id, station_id, payment_method_id, payment_values, payment_components, effective_from, effective_to, status, change_reason")
        .eq("company_id", companyId)
        .neq("status", "cancelled")
        .order("effective_from", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id"));
    loadError = allocationResult.error;
    const personIds = new Set(people.map((person) => person.id));
    allocations = (allocationResult.data ?? []).map((allocation: any) => ({
      ...allocation,
      person_id: String(allocation.helper_id ?? allocation.workforce_id)
    })).filter((allocation: AllocationRow) => personIds.has(allocation.person_id)
      && (allLocations || Boolean(allocation.station_id && allowedLocations.has(String(allocation.station_id)))));
  }

  const allMethods = paymentMethods((methodResult.data ?? []) as PaymentMethodRow[]);
  const activeMethodIds = new Set(((methodResult.data ?? []) as PaymentMethodRow[]).filter((method) => method.is_active).map((method) => method.id));
  const eligibleMethods = allMethods.filter((method) => activeMethodIds.has(method.id) && directPaymentMethodEligible(method.components));
  const productionMethodCount = allMethods.filter((method) => activeMethodIds.has(method.id) && method.components.some((component) => component.type === "production")).length;
  const methodNameById = new Map(allMethods.map((method) => [method.id, `${method.code} - ${method.name}`]));
  const designationLabelById = new Map(designations.map((designation) => [designation.id, `${designation.code} - ${designation.name}`]));
  const stationById = new Map((stationResult.data ?? []).map((station) => [station.id,
    station.station_name && station.station_name !== station.station_code
      ? `${station.station_code} - ${station.station_name}`
      : station.station_code
  ]));
  const historyByPerson = new Map<string, AllocationRow[]>();
  allocations.forEach((allocation) => historyByPerson.set(allocation.person_id, [
    ...(historyByPerson.get(allocation.person_id) ?? []),
    allocation
  ]));
  const today = todayKolkata();
  const rows: DirectPaymentAllocationRow[] = people.map((person) => {
    const history = historyByPerson.get(person.id) ?? [];
    const current = history.find((allocation) => allocation.status !== "cancelled"
      && allocation.effective_from <= today
      && (!allocation.effective_to || allocation.effective_to >= today))
      ?? history.find((allocation) => allocation.status === "active" && !allocation.effective_to)
      ?? null;
    const defaultEffectiveFrom = person.date_of_join && person.date_of_join > today ? person.date_of_join : today;
    return {
      personId: person.id,
      dropxId: person.dropx_id || "Not assigned",
      fullName: person.full_name,
      stationLabel: stationById.get(person.location_id ?? "") ?? "Location unavailable",
      designationLabel: audience === "helpers"
        ? person.designation || "Designation unavailable"
        : designationLabelById.get(person.designation_id ?? "")
          ?? (() => { const designation = designationByName.get(String(person.designation ?? "").trim().toLowerCase()); return designation ? `${designation.code} - ${designation.name}` : "Designation unavailable"; })(),
      dateOfJoin: person.date_of_join ?? "",
      allocationId: current?.id ?? "",
      paymentMethodId: current?.payment_method_id ?? "",
      currentMethodName: methodNameById.get(current?.payment_method_id ?? "") ?? "",
      paymentValues: Object.fromEntries(Object.entries(current?.payment_values ?? {})
        .map(([code, value]) => [code, Number(value)])
        .filter(([, value]) => Number.isFinite(value))),
      effectiveFrom: current?.effective_from ?? defaultEffectiveFrom,
      effectiveTo: current?.effective_to ?? "",
      history: sortPaymentAllocationHistory(history.map((allocation) => {
        const method = allMethods.find((candidate) => candidate.id === allocation.payment_method_id);
        const snapshotComponents = Array.isArray(allocation.payment_components) ? allocation.payment_components : [];
        const historyComponents = snapshotComponents.length
          ? snapshotComponents.map((component, index) => ({
            code: String(component.component_code ?? component.code ?? ""),
            label: String(component.label ?? component.component_code ?? component.code ?? ""),
            sortOrder: Number(component.sort_order ?? component.sortOrder ?? index)
          }))
          : (method?.components ?? []).map((component) => ({ code: component.code, label: component.label, sortOrder: component.sortOrder }));
        return {
          id: allocation.id,
          paymentMethodId: allocation.payment_method_id,
          paymentMethodName: method ? `${method.code} - ${method.name}` : "Payment method unavailable",
          effectiveFrom: allocation.effective_from,
          effectiveTo: allocation.effective_to ?? "",
          storedStatus: allocation.status,
          sourceLabel: audience === "helpers" ? "Helper direct pay" : "Workforce direct pay",
          subjectLabel: `${person.dropx_id || "Not assigned"} · ${person.full_name}`,
          locationLabel: stationById.get(allocation.station_id ?? "") ?? "Location unavailable",
          reason: allocation.change_reason ?? "",
          rates: paymentAllocationHistoryRates(allocation.payment_values, historyComponents)
        };
      }))
    };
  });

  const migrationMissing = loadError?.message?.includes(audience === "helpers" ? "helper_payment_allocations" : "workforce_payment_allocations")
    || loadError?.message?.includes("provider_mapping_required");

  return <AppShell active="ID Mapping" pageCode={pageCode}>
    <PageHead
      eyebrow="Provider-independent pay"
      subtitle={audience === "helpers"
        ? "Assign attendance, workday or fixed-amount payment methods to Helpers. Provider mapping is never required."
        : "Assign attendance, workday or fixed-amount payment methods to Field Operations designations that do not require provider mapping."}
      title="Direct pay allocations"
    />
    <nav aria-label="ID mapping views" className="performance-tabs">
      <Link href="/provider-id-mapping">Provider member first</Link>
      <Link className="active" href="/provider-mapping/direct-pay">Direct pay allocations</Link>
    </nav>
    <nav aria-label="Direct pay allocation categories" className="performance-tabs">
      <Link className={audience === "workforce" ? "active" : undefined} href="/provider-mapping/direct-pay">Workforce</Link>
      <Link className={audience === "helpers" ? "active" : undefined} href="/provider-mapping/direct-pay?audience=helpers">Helpers</Link>
    </nav>
    {loadError ? <section className="panel message-panel error"><div className="panel-body">
      <strong>{migrationMissing ? "Database update required" : "Unable to load direct pay allocations"}</strong>
      <p className="subtle">{migrationMissing ? "Apply the direct payment allocation database migration, then refresh this page." : loadError.message}</p>
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
    {!loadError ? <DirectPaymentAllocationWorksheet audience={audience} canEdit={canEdit} initialQuery={searchParams.q} methods={eligibleMethods} productionMethodCount={productionMethodCount} rows={rows} /> : null}
  </AppShell>;
}
