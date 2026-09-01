import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

export const physicalRegisterTables = [
  "employees",
  "contractors",
  "workforce",
  "vendors",
  "workers"
] as const;

export type PhysicalRegisterTable = typeof physicalRegisterTables[number];

type ResolvedRoute = {
  designation_id: string;
  register_id: string;
  register_code: string;
  table_name: PhysicalRegisterTable;
  profile_type: string;
  registration_enabled: boolean;
};

type DesignationWorkspaceRule = {
  designationId: string;
  peopleModule: string | null;
};

function isPhysicalRegisterTable(value: unknown): value is PhysicalRegisterTable {
  return physicalRegisterTables.includes(String(value) as PhysicalRegisterTable);
}

async function loadDesignationWorkspaceRule(companyId: string, designationId?: string | null) {
  if (!supabaseAdmin || !designationId) return null;
  const designationResult = await supabaseAdmin.from("designations")
    .select("id,designation_category_id,onboarding_categories")
    .eq("company_id", companyId).eq("id", designationId).eq("is_active", true).maybeSingle();
  if (designationResult.error) throw new Error(designationResult.error.message);
  if (!designationResult.data) return null;
  const categoryResult = designationResult.data.designation_category_id
    ? await supabaseAdmin.from("designation_categories")
      .select("people_module")
      .eq("company_id", companyId).eq("id", designationResult.data.designation_category_id)
      .eq("is_active", true).maybeSingle()
    : { data: null, error: null };
  if (categoryResult.error) throw new Error(categoryResult.error.message);
  return {
    designationId: designationResult.data.id,
    peopleModule: categoryResult.data?.people_module ?? null
  } satisfies DesignationWorkspaceRule;
}

function isPeopleModule(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().startsWith("people");
}

export async function resolveDesignationRegister({
  companyId,
  designationId,
  designationValue
}: {
  companyId: string;
  designationId?: string | null;
  designationValue?: string | null;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin.rpc("resolve_designation_register", {
    p_company_id: companyId,
    p_designation_id: designationId ?? null,
    p_designation_value: designationValue ?? null
  });
  if (result.error) {
    if (result.error.message.toLowerCase().includes("resolve_designation_register")) {
      throw new Error("Workforce Register Routing is not installed yet. Apply the designation routing migration.");
    }
    throw new Error(result.error.message);
  }
  const row = (result.data?.[0] ?? null) as ResolvedRoute | null;
  if (!row || !isPhysicalRegisterTable(row.table_name)) return null;
  return row;
}

export async function assertDesignationRegister({
  companyId,
  designationId,
  designationValue,
  expectedTables
}: {
  companyId: string;
  designationId?: string | null;
  designationValue?: string | null;
  expectedTables: PhysicalRegisterTable[];
}) {
  const workspaceRule = await loadDesignationWorkspaceRule(companyId, designationId);
  if (workspaceRule && isPeopleModule(workspaceRule.peopleModule)) {
    const peopleTables = expectedTables.filter((table) => table === "employees" || table === "contractors");
    const selected = peopleTables[0];
    if (!selected) {
      throw new Error("People designations may be used only for Employees or Independent Contractors.");
    }
    return {
      designation_id: workspaceRule.designationId,
      register_id: "master-category",
      register_code: selected,
      table_name: selected,
      profile_type: selected === "employees" ? "employee" : "contractor",
      registration_enabled: true
    } satisfies ResolvedRoute;
  }
  const route = await resolveDesignationRegister({ companyId, designationId, designationValue });
  if (!route) {
    throw new Error("This designation is not mapped in Workforce Master. Map it before registration.");
  }
  if (!route.registration_enabled) {
    throw new Error("Registration is disabled for this designation in Workforce Master.");
  }
  if (!expectedTables.includes(route.table_name)) {
    throw new Error(`This designation is routed to ${route.register_code}. Start the registration from that register.`);
  }
  return route;
}

export function targetRegisterForWorkforceRoute(returnPath: string): PhysicalRegisterTable {
  if (returnPath === "/vendors" || returnPath.endsWith("/vendors")) return "vendors";
  if (returnPath === "/workers" || returnPath.endsWith("/helpers")) return "workers";
  if (returnPath === "/contractors") return "contractors";
  return "workforce";
}

export async function loadMappedDesignationIds(companyId: string, tableName: PhysicalRegisterTable) {
  if (!supabaseAdmin) return new Set<string>();
  const result = await supabaseAdmin
    .from("designation_register_routes")
    .select("designation_id, registration_enabled, workforce_register_master!inner(table_name, is_active)")
    .eq("company_id", companyId)
    .eq("registration_enabled", true)
    .eq("workforce_register_master.table_name", tableName)
    .eq("workforce_register_master.is_active", true);
  if (result.error) throw new Error(result.error.message);
  return new Set((result.data ?? []).map((row) => String(row.designation_id)));
}
