import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { IdGenerationForm } from "./id-generation-form";

type SettingType = "dropx_id" | "biometric_id";
type ScopeType = "company" | "category" | "model" | "location" | "designation" | "multi_designation";

type GenerationConfig = {
  label?: string | null;
  prefix?: string | null;
  separator?: string | null;
  suffix?: string | null;
  next_serial_no?: number | null;
  serial_digits?: number | null;
  designation_ids?: string[] | null;
  is_locked?: boolean | null;
};

type SettingRow = {
  id: string;
  setting_type: SettingType;
  scope_type: ScopeType;
  configs: Record<string, GenerationConfig> | null;
  is_active: boolean;
  is_locked: boolean;
};

type OptionRow = {
  id: string;
  code?: string | null;
  name?: string | null;
  station_code?: string | null;
  station_name?: string | null;
};

const legacyCategoryKeys: Record<string, string> = {
  employees: "employee",
  workforce: "workforce",
  vendors: "vendor",
  contractors: "contractor",
  workers: "worker"
};

function idCategoryCode(code: string) {
  const compact = code.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return compact.slice(0, 5) || "CAT";
}

const settingCards: Array<{ type: SettingType; title: string; subtitle: string; defaultPrefix: string }> = [
  {
    type: "dropx_id",
    title: "DropX ID",
    subtitle: "Configure the worker code used as Employee ID or Workforce ID.",
    defaultPrefix: "DROPX"
  },
  {
    type: "biometric_id",
    title: "Biometric ID",
    subtitle: "Configure the biometric enrolment ID series.",
    defaultPrefix: ""
  }
];

function loadFlash() {
  const raw = cookies().get("dropx_id_generation_flash")?.value;
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

async function loadData(companyId: string, settingType: SettingType) {
  if (!supabaseAdmin) {
    return {
      designations: [] as OptionRow[],
      error: "Supabase service role key is not configured.",
      companyLabel: "Company",
      locations: [] as OptionRow[],
      models: [] as OptionRow[],
      settings: [] as SettingRow[],
      usedDesignationIds: [] as string[],
      categories: [] as Array<{ id: string; code: string; name: string }>
    };
  }
  const [settingsResult, companyResult, locationsResult, modelsResult, designationsResult, categoriesResult, usedDesignationsResult] = await Promise.all([
    (supabaseAdmin.from("dropx_id_generation_settings") as any)
      .select("id, setting_type, scope_type, configs, is_active, is_locked")
      .eq("company_id", companyId)
      .order("setting_type"),
    supabaseAdmin.from("companies").select("name, code").eq("id", companyId).maybeSingle(),
    supabaseAdmin.from("stations").select("id, station_code, station_name").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("location_models").select("id, code, name").eq("company_id", companyId).eq("is_active", true).order("code"),
    supabaseAdmin.from("designations").select("id, code, name").eq("company_id", companyId).eq("is_active", true).order("code"),
    supabaseAdmin.from("workforce_categories").select("code, name").eq("company_id", companyId).eq("is_active", true).order("sort_order").order("name"),
    (supabaseAdmin.rpc as any)("multi_designation_used_designation_ids", { p_company_id: companyId, p_setting_type: settingType })
  ]);
  const error = settingsResult.error?.message || companyResult.error?.message || locationsResult.error?.message || modelsResult.error?.message || designationsResult.error?.message || categoriesResult.error?.message || usedDesignationsResult.error?.message || null;
  const companyRow = companyResult.data as { name?: string | null; code?: string | null } | null;
  return {
    designations: (designationsResult.data ?? []) as OptionRow[],
    error,
    companyLabel: companyRow?.name || companyRow?.code || "Company",
    locations: (locationsResult.data ?? []) as OptionRow[],
    models: (modelsResult.data ?? []) as OptionRow[],
    settings: (settingsResult.data ?? []) as SettingRow[],
    usedDesignationIds: (usedDesignationsResult.data ?? []).map((row: { designation_id: string }) => String(row.designation_id)),
    categories: (categoriesResult.data ?? []).map((category) => ({
      id: legacyCategoryKeys[category.code] ?? category.code,
      code: idCategoryCode(category.code),
      name: category.name
    }))
  };
}

function selectedSettingType(value?: string): SettingType {
  return value === "biometric_id" ? "biometric_id" : "dropx_id";
}

export const dynamic = "force-dynamic";

export default async function DropxIdGenerationSettingsPage({ searchParams }: { searchParams?: { type?: string } }) {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.app_settings;
  const { error: flashError, notice } = loadFlash();
  const currentType = selectedSettingType(searchParams?.type);
  const data = await loadData(companyId, currentType);
  const settingByType = new Map(data.settings.map((setting) => [setting.setting_type, setting]));
  const currentCard = settingCards.find((card) => card.type === currentType) ?? settingCards[0];

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Settings"
        title={`${currentCard.title} Generation`}
        subtitle="Choose one generation method, then configure only that method's structure."
      />

      <div className="id-generation-switch">
        <PendingLink className="button secondary compact" href="/settings/dropx-id-generation?type=dropx_id">DropX ID</PendingLink>
        <PendingLink className="button secondary compact" href="/settings/dropx-id-generation?type=biometric_id">Biometric ID</PendingLink>
      </div>

      {data.error || flashError || notice ? (
        <section className={`panel message-panel ${data.error || flashError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{data.error || flashError ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error || flashError || notice}</p>
          </div>
        </section>
      ) : null}

      <IdGenerationForm
        canEdit={permission.canAdd || permission.canEdit}
        categories={data.categories}
        companyLabel={data.companyLabel}
        defaultPrefix={currentCard.defaultPrefix}
        designations={data.designations}
        key={currentCard.type}
        locations={data.locations}
        models={data.models}
        setting={settingByType.get(currentCard.type)}
        subtitle={currentCard.subtitle}
        title={currentCard.title}
        type={currentCard.type}
        usedDesignationIds={data.usedDesignationIds}
      />
    </AppShell>
  );
}
