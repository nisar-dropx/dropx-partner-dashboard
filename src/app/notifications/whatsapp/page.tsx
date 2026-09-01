import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { BulkWhatsAppPanel } from "@/components/bulk-whatsapp-panel";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WhatsAppTemplateComponent } from "@/lib/whatsapp-template";

export const dynamic = "force-dynamic";

type LocationRow = {
  id: string;
  station_code: string;
  providers?: { name?: string | null } | { name?: string | null }[] | null;
  location_models?: { code?: string | null; name?: string | null } | { code?: string | null; name?: string | null }[] | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  mobile: string | null;
  mobile_country_code?: string | null;
  role_id: string | null;
  role: string | null;
  location_scope_ids: string[] | null;
  is_active: boolean;
};

type UserRoleRow = {
  id: string;
  name: string;
};

type FieldExecutiveRow = {
  id: string;
  dropx_id: string | null;
  full_name: string;
  email: string | null;
  mobile: string;
  mobile_country_code?: string | null;
  designation?: string | null;
  onboarding_status?: string | null;
  is_active: boolean;
  stations?: WorkforceLocation | WorkforceLocation[] | null;
};

type EmployeeRow = {
  id: string;
  employee_code: string | null;
  full_name: string;
  email: string | null;
  mobile: string;
  mobile_country_code?: string | null;
  profile_completion_status?: string | null;
  is_active: boolean;
  stations?: WorkforceLocation | WorkforceLocation[] | null;
  designations?: { name?: string | null } | { name?: string | null }[] | null;
};

type WorkforceLocation = {
  station_code?: string | null;
  providers?: { name?: string | null } | { name?: string | null }[] | null;
  location_models?: { code?: string | null; name?: string | null } | { code?: string | null; name?: string | null }[] | null;
};

type CampaignRecipientRow = {
  id: string;
  row_no: number;
  recipient_name: string | null;
  recipient_mobile: string;
  country_code: string | null;
  status: string;
  provider_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  updated_at: string | null;
};

type CampaignRow = {
  id: string;
  campaign_code: string;
  whatsapp_profile_id: string | null;
  whatsapp_profile_name: string | null;
  created_at: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  pending_count: number;
  status: string;
  whatsapp_campaign_recipients?: CampaignRecipientRow[];
};

type WhatsAppProfileRow = {
  id: string;
  profile_name: string;
  phone_number_id: string;
  default_country_code: string;
  is_default: boolean;
  is_active: boolean;
};

function loadFlash() {
  const raw = cookies().get("dropx_bulk_whatsapp_flash")?.value;
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

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeMobile(value: string | null | undefined) {
  return String(value ?? "").replace(/\D/g, "");
}

function relationList<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function workforceStatus(status: string | null | undefined, isActive: boolean) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "under_review") return "Under Review";
  if (normalized === "returned") return "Returned";
  if (normalized === "submitted") return "Submitted";
  if (normalized === "pending" || normalized === "draft") return "Pending";
  if (normalized === "active") return "Active";
  return isActive ? "Active" : "Inactive";
}

async function loadBulkWhatsAppData(companyId: string) {
  const defaults = {
    contacts: [],
    error: null as string | null,
    campaignError: null as string | null,
    templates: [] as Array<{ template_id: string; whatsapp_profile_id: string | null; name: string; language: string; category: string | null; status: string; components: WhatsAppTemplateComponent[] }>,
    campaigns: [] as CampaignRow[],
    profiles: [] as WhatsAppProfileRow[],
    defaultCountryCode: "91",
    whatsAppEnabled: false
  };
  if (!supabaseAdmin) return { ...defaults, error: "Supabase service role key is not configured." };

  const workforceLocationSelect = "stations (station_code, providers (name), location_models (code, name))";
  const [settings, templates, profiles, userRoles, senderProfiles, campaignProfiles, employees, fieldExecutives, contractors, vendors, workers, locations, campaigns] = await Promise.all([
    supabaseAdmin.from("whatsapp_settings").select("is_enabled").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin.from("whatsapp_template_cache").select("template_id, whatsapp_profile_id, name, language, category, status, components").eq("company_id", companyId).order("name"),
    supabaseAdmin.from("profiles").select("id, full_name, email, mobile, mobile_country_code, role_id, role, location_scope_ids, is_active").eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("user_roles").select("id, name").eq("company_id", companyId),
    supabaseAdmin.from("whatsapp_profiles").select("id, profile_name, phone_number_id, default_country_code, is_default, is_active").eq("company_id", companyId).eq("is_active", true).order("profile_name"),
    supabaseAdmin.from("whatsapp_profiles").select("id, profile_name").eq("company_id", companyId),
    supabaseAdmin.from("employees").select(`id, employee_code, full_name, email, mobile, mobile_country_code, profile_completion_status, is_active, ${workforceLocationSelect}, designations (name)`).eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("workforce").select(`id, dropx_id, full_name, email, mobile, mobile_country_code, designation, onboarding_status, is_active, ${workforceLocationSelect}`).eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("contractors").select(`id, dropx_id, full_name, email, mobile, mobile_country_code, designation, onboarding_status, is_active, ${workforceLocationSelect}`).eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("vendors").select(`id, dropx_id, full_name, email, mobile, mobile_country_code, designation, onboarding_status, is_active, ${workforceLocationSelect}`).eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("workers").select(`id, dropx_id, full_name, email, mobile, mobile_country_code, designation, onboarding_status, is_active, ${workforceLocationSelect}`).eq("company_id", companyId).order("full_name"),
    supabaseAdmin.from("stations").select("id, station_code, providers (name), location_models (code, name)").eq("company_id", companyId),
    supabaseAdmin
      .from("whatsapp_campaigns")
      .select("id, campaign_code, whatsapp_profile_id, whatsapp_profile_name, created_at, total_count, sent_count, failed_count, pending_count, status, whatsapp_campaign_recipients (id, row_no, recipient_name, recipient_mobile, country_code, status, provider_message_id, error_message, sent_at, updated_at)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(25)
  ]);

  const campaignSetupMissing = campaigns.error?.message?.includes("whatsapp_campaigns") || campaigns.error?.message?.includes("whatsapp_campaign_recipients");
  const error = settings.error?.message || templates.error?.message || profiles.error?.message || userRoles.error?.message || senderProfiles.error?.message || campaignProfiles.error?.message ||
    employees.error?.message || fieldExecutives.error?.message || contractors.error?.message || vendors.error?.message || workers.error?.message || locations.error?.message || null;
  const locationsById = new Map(((locations.data ?? []) as LocationRow[]).map((location) => [location.id, location]));
  const roleNameById = new Map(((userRoles.data ?? []) as UserRoleRow[]).map((role) => [role.id, role.name]));
  const profileNameById = new Map(((campaignProfiles.data ?? []) as Array<{ id: string; profile_name: string }>).map((profile) => [profile.id, profile.profile_name]));
  const userContacts = ((profiles.data ?? []) as ProfileRow[])
    .filter((profile) => normalizeMobile(profile.mobile))
    .map((profile) => {
      const scopedLocations = (profile.location_scope_ids ?? []).map((id) => locationsById.get(id)).filter(Boolean) as LocationRow[];
      const assignedRole = (profile.role_id ? roleNameById.get(profile.role_id) : null) || profile.role || "User";
      return {
        id: `profile:${profile.id}`,
        source: "Dashboard User",
        name: profile.full_name || profile.email || "User",
        mobile: normalizeMobile(profile.mobile),
        country_code: normalizeMobile(profile.mobile_country_code) || "91",
        email: profile.email ?? "",
        dropx_id: "",
        location: scopedLocations.map((location) => location.station_code).join(", "),
        provider: scopedLocations.flatMap((location) => relationList(location.providers).map((provider) => provider.name ?? "")).filter(Boolean).join(", "),
        model: scopedLocations.flatMap((location) => relationList(location.location_models).map((model) => model.code || model.name || "")).filter(Boolean).join(", "),
        role: assignedRole,
        designation: assignedRole,
        status: profile.is_active ? "Active" : "Inactive"
      };
    });

  function workforceContacts(rows: FieldExecutiveRow[], source: string, idPrefix: string) {
    return rows
      .filter((person) => normalizeMobile(person.mobile))
      .map((person) => {
        const station = firstRelation(person.stations);
        const provider = firstRelation(station?.providers);
        const model = firstRelation(station?.location_models);
        return {
          id: `${idPrefix}:${person.id}`,
          source,
          name: person.full_name,
          mobile: normalizeMobile(person.mobile),
          country_code: normalizeMobile(person.mobile_country_code) || "91",
          email: person.email ?? "",
          dropx_id: person.dropx_id ?? "",
          location: station?.station_code ?? "",
          provider: provider?.name ?? "",
          model: model?.code || model?.name || "",
          role: person.designation || source,
          designation: person.designation || source,
          status: workforceStatus(person.onboarding_status, person.is_active)
        };
      });
  }

  const employeeContacts = ((employees.data ?? []) as EmployeeRow[])
    .filter((employee) => normalizeMobile(employee.mobile))
    .map((employee) => {
      const station = firstRelation(employee.stations);
      const designation = firstRelation(employee.designations);
      const provider = firstRelation(station?.providers);
      const model = firstRelation(station?.location_models);
      return {
        id: `employee:${employee.id}`,
        source: "Employee",
        name: employee.full_name,
        mobile: normalizeMobile(employee.mobile),
        country_code: normalizeMobile(employee.mobile_country_code) || "91",
        email: employee.email ?? "",
        dropx_id: employee.employee_code ?? "",
        location: station?.station_code ?? "",
        provider: provider?.name ?? "",
        model: model?.code || model?.name || "",
        role: designation?.name || "Employee",
        designation: designation?.name || "Employee",
        status: workforceStatus(employee.profile_completion_status, employee.is_active)
      };
    });
  const executiveContacts = workforceContacts((fieldExecutives.data ?? []) as FieldExecutiveRow[], "Field Executive", "field_executive");
  const contractorContacts = workforceContacts((contractors.data ?? []) as FieldExecutiveRow[], "Independent Contractor", "contractor");
  const vendorContacts = workforceContacts((vendors.data ?? []) as FieldExecutiveRow[], "Vendor", "vendor");
  const workerContacts = workforceContacts((workers.data ?? []) as FieldExecutiveRow[], "Worker", "worker");

  return {
    contacts: [...userContacts, ...employeeContacts, ...executiveContacts, ...contractorContacts, ...vendorContacts, ...workerContacts]
      .sort((left, right) => left.name.localeCompare(right.name)),
    error,
    campaignError: campaignSetupMissing ? `${campaigns.error?.message} Run scripts/whatsapp_campaigns_v1.sql in Supabase SQL Editor.` : campaigns.error?.message ?? null,
    campaigns: ((campaigns.data ?? []) as CampaignRow[]).map((campaign) => ({
      ...campaign,
      whatsapp_profile_name: campaign.whatsapp_profile_id ? profileNameById.get(campaign.whatsapp_profile_id) ?? campaign.whatsapp_profile_name : campaign.whatsapp_profile_name,
      whatsapp_campaign_recipients: [...(campaign.whatsapp_campaign_recipients ?? [])].sort((left, right) => left.row_no - right.row_no)
    })),
    templates: (templates.data ?? []) as typeof defaults.templates,
    profiles: (senderProfiles.data ?? []) as WhatsAppProfileRow[],
    defaultCountryCode: ((senderProfiles.data ?? []) as WhatsAppProfileRow[]).find((profile) => profile.is_default)?.default_country_code || "91",
    whatsAppEnabled: Boolean(settings.data?.is_enabled)
  };
}

export default async function BulkWhatsAppPage() {
  const authorization = await requirePagePermission("notifications_whatsapp", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.notifications_whatsapp;
  const data = await loadBulkWhatsAppData(companyId);
  const flash = loadFlash();

  return (
    <AppShell active="WhatsApp" pageCode="notifications_whatsapp">
      <PageHead
        eyebrow="Notifications"
        title="WhatsApp"
        subtitle="Send WhatsApp template messages in bulk from existing dashboard data or uploaded Excel rows."
      />
      {data.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Action required</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error}</p>
          </div>
        </section>
      ) : (
        <BulkWhatsAppPanel
          canSend={permission.canAdd || permission.canEdit}
          campaignError={data.campaignError}
          campaigns={data.campaigns}
          contacts={data.contacts}
          defaultCountryCode={data.defaultCountryCode}
          flash={flash}
          profiles={data.profiles}
          templates={data.templates}
          whatsAppEnabled={data.whatsAppEnabled}
        />
      )}
    </AppShell>
  );
}
