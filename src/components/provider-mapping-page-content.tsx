import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import {
  ProviderMappingWorksheet,
  type LocationOption,
  type MappingWorksheetRow,
  type PaymentMethodOption
} from "@/components/provider-mapping-worksheet";
import { type AuthorizationContext, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type LocationRow = {
  id: string;
  station_code: string;
  station_name: string | null;
  provider_id: string | null;
};

type ExecutiveRow = {
  id: string;
  full_name: string;
  date_of_join: string;
  location_id: string;
  dropx_id: string | null;
  is_active: boolean;
};

type EmployeeRow = {
  id: string;
  full_name: string;
  date_of_join: string;
  location_id: string | null;
  employee_code: string | null;
  is_active: boolean;
};

type ContractorRow = {
  id: string;
  full_name: string;
  date_of_join: string;
  location_id: string | null;
  dropx_id: string | null;
  designation: string | null;
  is_active: boolean;
};

type FieldOperationsDesignationRow = {
  code: string;
  name: string;
};

type WorkforceRow = {
  id: string;
  source_profile_type: "employee" | "contractor" | "field_executive" | string | null;
  source_profile_id: string | null;
  full_name: string;
  date_of_join: string | null;
  location_id: string | null;
  dropx_id: string | null;
  is_active: boolean;
};

type MappingRow = {
  id: string;
  field_executive_id: string | null;
  employee_id: string | null;
  contractor_id: string | null;
  provider_member_id: string;
  provider_id: string;
  station_id: string | null;
  effective_from: string;
  effective_to: string | null;
  payment_method_id: string | null;
  payment_values: Record<string, number | string> | null;
  pay_type: string;
  delivery_rate: number | string | null;
  pickup_rate: number | string | null;
  mfn_rate: number | string | null;
  mfn_return_rate: number | string | null;
  guarantee_amount: number | string | null;
  guarantee_schedule: string | null;
  fuel_rate: number | string | null;
  reason: string | null;
  status: string;
};

type PaymentMethodRow = {
  id: string;
  code: string;
  name: string;
  payment_method_components?: Array<{
    component_code: string;
    component_type: "amount" | "production";
    label: string;
    sort_order: number;
  }> | null;
};

function amountValue(value: number | string | null | undefined) {
  return value === null || value === undefined ? "" : String(value);
}

function executiveDropxId(id: string) {
  return `FE-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function loadFlashMessage() {
  const raw = cookies().get("dropx_provider_mapping_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadMappingData(authorization: AuthorizationContext) {
  if (!supabaseAdmin) {
    return {
      locations: [] as LocationOption[],
      mappings: [] as MappingWorksheetRow[],
      paymentMethods: [] as PaymentMethodOption[],
      error: "Supabase service role key is not configured."
    };
  }

  const companyId = requireCompanyId(authorization);
  const [locationsResult, executivesResult, employeesResult, contractorsResult, workforceResult, designationsResult, mappingsResult, paymentMethodsResult] = await Promise.all([
    supabaseAdmin
      .from("stations")
      .select("id, station_code, station_name, provider_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("station_code"),
    supabaseAdmin
      .from("field_executives")
      .select(`
        id,
        full_name,
        date_of_join,
        location_id,
        dropx_id,
        is_active
      `)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("full_name"),
    supabaseAdmin
      .from("employees")
      .select("id, full_name, date_of_join, location_id, employee_code, is_active, designations!inner(is_field_operations)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .eq("designations.is_field_operations", true)
      .order("full_name"),
    supabaseAdmin
      .from("contractors")
      .select("id, full_name, date_of_join, location_id, dropx_id, designation, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("full_name"),
    supabaseAdmin
      .from("workforce")
      .select("id, source_profile_type, source_profile_id, full_name, date_of_join, location_id, dropx_id, is_active, designations!inner(is_field_operations)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .eq("designations.is_field_operations", true)
      .order("full_name"),
    supabaseAdmin
      .from("designations")
      .select("code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("is_field_operations", true),
    supabaseAdmin
      .from("field_executive_provider_mappings")
      .select(`
        id,
        field_executive_id,
        employee_id,
        contractor_id,
        provider_id,
        station_id,
        provider_member_id,
        effective_from,
        effective_to,
        payment_method_id,
        payment_values,
        pay_type,
        delivery_rate,
        pickup_rate,
        mfn_rate,
        mfn_return_rate,
        guarantee_amount,
        guarantee_schedule,
        fuel_rate,
        reason,
        status
      `)
      .eq("company_id", companyId)
      .neq("status", "cancelled")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("payment_methods")
      .select(`
        id,
        code,
        name,
        payment_method_components (
          component_code,
          component_type,
          label,
          sort_order
        )
      `)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("code")
  ]);

  const paymentMethods = ((paymentMethodsResult.data ?? []) as PaymentMethodRow[]).map((method) => ({
    id: method.id,
    code: method.code,
    name: method.name,
    components: (method.payment_method_components ?? [])
      .slice()
      .sort((first, second) => first.sort_order - second.sort_order)
      .map((component) => ({
        code: component.component_code,
        label: component.label,
        type: component.component_type
      }))
  }));
  const allocatedLocationIds = new Set(authorization.locationScopeIds);
  const hasAllLocations = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
  const isAllocatedLocation = (locationId: string | null | undefined) =>
    hasAllLocations || Boolean(locationId && allocatedLocationIds.has(locationId));
  const locationRows = ((locationsResult.data ?? []) as LocationRow[])
    .filter((location) => isAllocatedLocation(location.id));
  const locationProviderById = new Map(locationRows.map((location) => [location.id, location.provider_id ?? ""]));
  const locations = locationRows.map((location) => ({
    id: location.id,
    label: location.station_name && location.station_name !== location.station_code
      ? `${location.station_code} - ${location.station_name}`
      : location.station_code,
    providerId: location.provider_id ?? undefined
  }));
  const latestMappingByWorkerKey = new Map<string, MappingRow>();
  ((mappingsResult.data ?? []) as MappingRow[])
    .filter((mapping) => isAllocatedLocation(mapping.station_id))
    .forEach((mapping) => {
    const key = mapping.employee_id
      ? `employee:${mapping.employee_id}`
      : mapping.contractor_id
        ? `contractor:${mapping.contractor_id}`
        : `field_executive:${mapping.field_executive_id}`;
    if (!latestMappingByWorkerKey.has(key)) {
      latestMappingByWorkerKey.set(key, mapping);
    }
  });

  const fieldOperationsDesignationKeys = new Set(
    ((designationsResult.data ?? []) as FieldOperationsDesignationRow[])
      .flatMap((designation) => [designation.code, designation.name])
      .map((value) => value.trim().toLowerCase())
  );
  const legacyWorkers = [
    ...((employeesResult.data ?? []) as unknown as EmployeeRow[]).filter((employee) => isAllocatedLocation(employee.location_id)).map((employee) => ({
      id: employee.id,
      sourceType: "employee" as const,
      fullName: employee.full_name,
      dateOfJoin: employee.date_of_join,
      locationId: employee.location_id ?? "",
      dropxId: employee.employee_code ?? ""
    })),
    ...((contractorsResult.data ?? []) as ContractorRow[])
      .filter((contractor) => isAllocatedLocation(contractor.location_id) && fieldOperationsDesignationKeys.has((contractor.designation ?? "").trim().toLowerCase()))
      .map((contractor) => ({
        id: contractor.id,
        sourceType: "contractor" as const,
        fullName: contractor.full_name,
        dateOfJoin: contractor.date_of_join,
        locationId: contractor.location_id ?? "",
        dropxId: contractor.dropx_id ?? ""
      })),
    ...((executivesResult.data ?? []) as ExecutiveRow[]).filter((executive) => isAllocatedLocation(executive.location_id)).map((executive) => ({
      id: executive.id,
      sourceType: "field_executive" as const,
      fullName: executive.full_name,
      dateOfJoin: executive.date_of_join,
      locationId: executive.location_id,
      dropxId: executive.dropx_id || executiveDropxId(executive.id)
    }))
  ];
  const canonicalWorkers = ((workforceResult.data ?? []) as unknown as WorkforceRow[])
    .filter((worker) =>
      Boolean(worker.source_profile_id) &&
      (worker.source_profile_type === "employee" || worker.source_profile_type === "contractor" || worker.source_profile_type === "field_executive") &&
      isAllocatedLocation(worker.location_id)
    )
    .map((worker) => ({
      id: worker.source_profile_id!,
      sourceType: worker.source_profile_type as "employee" | "contractor" | "field_executive",
      fullName: worker.full_name,
      dateOfJoin: worker.date_of_join ?? new Date().toISOString().slice(0, 10),
      locationId: worker.location_id ?? "",
      dropxId: worker.dropx_id ?? ""
    }));
  const workers = Array.from(
    [...legacyWorkers, ...canonicalWorkers].reduce((bySource, worker) => {
      bySource.set(`${worker.sourceType}:${worker.id}`, worker);
      return bySource;
    }, new Map<string, (typeof legacyWorkers)[number]>()).values()
  );

  const mappings = workers.map((worker) => {
      const mapping = latestMappingByWorkerKey.get(`${worker.sourceType}:${worker.id}`);
      const stationId = mapping?.station_id ?? worker.locationId;
      return {
      id: worker.id,
      sourceType: worker.sourceType,
      mappingId: mapping?.id ?? "",
      dropxId: worker.dropxId,
      dropxName: worker.fullName,
      providerMemberId: mapping?.provider_member_id ?? "",
      providerId: mapping?.provider_id ?? locationProviderById.get(stationId) ?? "",
      stationId,
      effectiveFrom: mapping?.effective_from ?? worker.dateOfJoin,
      effectiveTo: mapping?.effective_to ?? "",
      paymentMethodId: mapping?.payment_method_id ?? "",
      paymentValues: Object.fromEntries(Object.entries(mapping?.payment_values ?? {}).map(([key, value]) => [key, amountValue(value)])),
      deliveryRate: amountValue(mapping?.delivery_rate),
      pickupRate: amountValue(mapping?.pickup_rate),
      mfnRate: amountValue(mapping?.mfn_rate),
      mfnReturnRate: amountValue(mapping?.mfn_return_rate),
      guaranteeAmount: amountValue(mapping?.guarantee_amount),
      guaranteeSchedule: mapping?.guarantee_schedule ?? "",
      fuelRate: amountValue(mapping?.fuel_rate),
      reason: mapping?.reason ?? ""
    };
  });

  return {
    locations,
    mappings,
    paymentMethods,
    error: mappingsResult.error?.message || employeesResult.error?.message || contractorsResult.error?.message || workforceResult.error?.message || designationsResult.error?.message || executivesResult.error?.message || locationsResult.error?.message || paymentMethodsResult.error?.message || null
  };
}

export async function ProviderMappingPageContent({
  active = "ID Mapping",
  pageCode = "provider_mapping"
}: {
  active?: string;
  pageCode?: string;
}) {
  const authorization = await requirePagePermission(pageCode, "access");
  const permission = authorization.permissions[pageCode];
  const { locations, mappings, paymentMethods, error } = await loadMappingData(authorization);
  const flash = loadFlashMessage();
  const flashError = flash.error;
  const flashNotice = flash.notice;
  const canEditWorksheet = pageCode === "provider_mapping" && (permission.canAdd || permission.canEdit);

  return (
    <AppShell active={active} pageCode={pageCode}>
      <PageHead
        eyebrow="Source-of-truth bridge"
        title="ID & pay mapping"
        subtitle="Maintain DropX ID to Provider Member ID mappings, date-effective history, and payout rates in editable rows."
      />

      {error || flashError || flashNotice ? (
        <section
          className={`panel message-panel ${error || flashError ? "error" : "success"}`}
          id={!error && !flashError && flashNotice ? "provider-mapping-success" : undefined}
        >
          <div className="panel-body">
            <strong>{error || flashError ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error ?? flashError ?? flashNotice}
              {error?.includes("field_executive_provider_mappings")
                ? " Run scripts/provider_id_mappings_v1.sql in Supabase SQL Editor."
                : error?.includes("field_executives") ? " Run scripts/field_executives_v1.sql in Supabase SQL Editor." : ""}
            </p>
          </div>
        </section>
      ) : null}

      {(permission.canView || permission.canAdd || permission.canEdit) && !error ? (
        <ProviderMappingWorksheet
          canEdit={canEditWorksheet && !error}
          locations={locations}
          mappings={mappings}
          paymentMethods={paymentMethods}
        />
      ) : null}
    </AppShell>
  );
}
