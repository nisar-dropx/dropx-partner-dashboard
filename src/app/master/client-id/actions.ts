"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isCompanyOwner, requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Provider = { name?: string | null };
type Station = {
  id: string;
  station_code: string;
  hide_from_location_list?: boolean | null;
  parent_station_id?: string | null;
  providers?: Provider | Provider[] | null;
};
type StationSetting = {
  station_id: string;
  service_area_code: string;
  amazon_service_area_id: string | null;
  service_type: string;
  supervisor_alias: string;
  contract_type: string;
  associate_email_pattern: string | null;
  invitation_enabled: boolean;
  version: number;
};

function relation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function isAmazonStation(station: Station) {
  return String(relation(station.providers)?.name ?? "").toLowerCase().includes("amazon");
}

function destination(params: Record<string, string | number | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && String(value)) query.set(key, String(value));
  }
  return `/master/client-id?${query.toString()}`;
}

function isRedirectError(error: unknown) {
  return Boolean(error && typeof error === "object" && "digest" in error && String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT"));
}

async function scopedAmazonStations(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) throw new Error("Database connection unavailable.");
  const result = await supabaseAdmin
    .from("stations")
    .select("id,station_code,hide_from_location_list,parent_station_id,providers(name)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .order("station_code")
    .limit(500);
  if (result.error) throw new Error(result.error.message);
  return filterOnboardingLocations((result.data ?? []) as Station[], authorization)
    .filter(isAmazonStation)
    .filter((station) => !/^TEST(?:\s|$)/i.test(station.station_code));
}

function validEmailPattern(value: string) {
  const placeholders = value.includes("{station_code}") && (value.includes("{first_name}") || value.includes("{full_name}"));
  const rendered = value
    .replaceAll("{station_code}", "station")
    .replaceAll("{first_name}", "associate")
    .replaceAll("{full_name}", "associate.name");
  return placeholders && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rendered);
}

function revalidateClientIdMaster() {
  revalidatePath("/master/client-id");
  revalidatePath("/work-force-register");
}

export async function saveClientIdStation(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  const companyId = requireCompanyId(authorization);
  const text = (name: string) => String(formData.get(name) ?? "").trim();
  const stationId = text("station_id");
  try {
    if (authorization.readOnly || !supabaseAdmin) throw new Error("Station setup is unavailable in read-only mode.");
    const stations = await scopedAmazonStations(companyId, authorization);
    if (!stations.some((station) => station.id === stationId)) throw new Error("Choose an Amazon station in your location scope.");
    const serviceAreaCode = text("service_area_code").toUpperCase();
    const supervisorAlias = text("supervisor_alias");
    const contractType = text("contract_type");
    const emailPattern = text("associate_email_pattern").toLowerCase();
    const version = Number(text("version"));
    if (!/^[A-Z0-9_-]{2,24}$/.test(serviceAreaCode)) throw new Error("Enter the exact Amazon service-area code.");
    if (!/^[a-zA-Z0-9._-]{2,80}$/.test(supervisorAlias)) throw new Error("Enter the Amazon supervisor badge login without @amazon.com.");
    if (!Number.isInteger(version) || version < 0) throw new Error("Refresh the station master before saving again.");
    if (!["Independent Contractor", "Subcontractor", "DSP Employed"].includes(contractType)) throw new Error("Choose the approved Amazon DA contract type.");
    if (emailPattern && !validEmailPattern(emailPattern)) throw new Error("The optional email pattern must include {station_code} and {first_name} or {full_name}, followed by a valid domain.");
    const result = await supabaseAdmin.rpc("workforce_save_amazon_station", {
      p_company: companyId,
      p_actor: authorization.userId,
      p_actor_name: authorization.fullName || authorization.email || "OpsPulse",
      p_station: stationId,
      p_version: version,
      p_locations: authorization.hasAllLocationAccess ? null : stations.map((station) => station.id),
      p_settings: {
        service_area_code: serviceAreaCode,
        amazon_service_area_id: text("amazon_service_area_id") || null,
        service_type: "Amazon Logistics",
        supervisor_alias: supervisorAlias,
        contract_type: contractType,
        associate_email_pattern: emailPattern || null,
        invitation_enabled: formData.get("invitation_enabled") === "on"
      }
    });
    if (result.error) throw new Error(result.error.message);
    revalidateClientIdMaster();
    redirect(destination({ station: stationId, notice: "Station Client ID settings saved." }));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(destination({ station: stationId, error: error instanceof Error ? error.message : "Unable to save the station settings." }));
  }
}

export async function enableMissingAmazonStations(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (authorization.readOnly || !authorization.hasAllLocationAccess || !supabaseAdmin) throw new Error("Company-wide edit access is required to configure all stations.");
    const stations = await scopedAmazonStations(companyId, authorization);
    const [settingResult, areaResult, defaultResult] = await Promise.all([
      supabaseAdmin.from("workforce_amazon_station_settings").select("station_id,service_area_code,amazon_service_area_id,service_type,supervisor_alias,contract_type,associate_email_pattern,invitation_enabled,version").eq("company_id", companyId),
      supabaseAdmin.from("workforce_amazon_service_areas").select("service_area_id,station_code").eq("company_id", companyId),
      supabaseAdmin.from("workforce_amazon_supervisor_defaults").select("supervisor_alias").eq("company_id", companyId).maybeSingle()
    ]);
    if (settingResult.error || areaResult.error || defaultResult.error) throw new Error(settingResult.error?.message || areaResult.error?.message || defaultResult.error?.message || "Unable to load the shared station setup.");
    const supervisorAlias = String(defaultResult.data?.supervisor_alias ?? "").trim();
    if (!/^[a-zA-Z0-9._-]{2,80}$/.test(supervisorAlias)) throw new Error("Configure the shared Amazon supervisor badge before enabling stations.");
    const settingByStation = new Map(((settingResult.data ?? []) as StationSetting[]).map((setting) => [setting.station_id, setting]));
    const areaByCode = new Map((areaResult.data ?? []).map((area) => [String(area.station_code).toUpperCase(), String(area.service_area_id)]));
    let updated = 0;
    for (const station of stations) {
      const current = settingByStation.get(station.id);
      if (current?.invitation_enabled) continue;
      const result = await supabaseAdmin.rpc("workforce_save_amazon_station", {
        p_company: companyId,
        p_actor: authorization.userId,
        p_actor_name: authorization.fullName || authorization.email || "OpsPulse",
        p_station: station.id,
        p_version: current?.version ?? 0,
        p_locations: null,
        p_settings: {
          service_area_code: current?.service_area_code || station.station_code.toUpperCase(),
          amazon_service_area_id: current?.amazon_service_area_id || areaByCode.get(station.station_code.toUpperCase()) || null,
          service_type: current?.service_type || "Amazon Logistics",
          supervisor_alias: supervisorAlias,
          contract_type: current?.contract_type || "Independent Contractor",
          associate_email_pattern: current?.associate_email_pattern || null,
          invitation_enabled: true
        }
      });
      if (result.error) throw new Error(`${station.station_code}: ${result.error.message}`);
      updated += 1;
    }
    revalidateClientIdMaster();
    redirect(destination({ notice: `${updated} Amazon station${updated === 1 ? "" : "s"} enabled with supervisor ${supervisorAlias}.` }));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(destination({ error: error instanceof Error ? error.message : "Unable to enable all Amazon stations." }));
  }
}

export async function saveAmazonOnboardingConnection(formData: FormData) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  try {
    if (!isCompanyOwner(authorization) || authorization.readOnly || !supabaseAdmin) throw new Error("Only the company owner can change the secure Amazon worker connection.");
    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const version = Number(formData.get("version"));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.length > 254) throw new Error("Enter a valid Amazon LSC login email.");
    if (password.length > 1024 || !Number.isInteger(version) || version < 0) throw new Error("Refresh the connection and enter valid credentials.");
    const result = await supabaseAdmin.rpc("workforce_save_amazon_connection", {
      p_company: requireCompanyId(authorization),
      p_actor: authorization.userId,
      p_username: username,
      p_password: password || null,
      p_enabled: formData.get("enabled") === "on",
      p_version: version,
      p_request_login: formData.get("intent") === "test"
    });
    if (result.error) throw new Error(result.error.message);
    revalidateClientIdMaster();
    redirect(destination({ notice: formData.get("enabled") === "on" ? "Amazon LSC worker connection saved and enabled." : "Amazon LSC worker connection saved and paused." }));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(destination({ error: error instanceof Error ? error.message : "Unable to save the Amazon worker connection." }));
  }
}
