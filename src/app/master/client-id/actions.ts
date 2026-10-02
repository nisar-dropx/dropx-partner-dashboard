"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { callWorkforceAmazonWorker } from "@/lib/workforce-amazon-worker";

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
    const station = stations.find((candidate) => candidate.id === stationId);
    if (!station) throw new Error("Choose an Amazon station in your location scope.");
    const serviceAreaCode = station.station_code.toUpperCase();
    const supervisorAlias = text("supervisor_alias");
    const contractType = text("contract_type");
    const emailPattern = text("associate_email_pattern").toLowerCase();
    const version = Number(text("version"));
    const invitationEnabled = formData.get("invitation_enabled") === "on";
    if (!/^[A-Z0-9_-]{2,24}$/.test(serviceAreaCode)) throw new Error("Enter the exact Amazon service-area code.");
    if (!/^[a-zA-Z0-9._-]{2,80}$/.test(supervisorAlias)) throw new Error("Enter the Amazon supervisor badge login without @amazon.com.");
    if (!Number.isInteger(version) || version < 0) throw new Error("Refresh the station master before saving again.");
    if (!["Independent Contractor", "Subcontractor", "DSP Employed"].includes(contractType)) throw new Error("Choose the approved Amazon DA contract type.");
    if (emailPattern && !validEmailPattern(emailPattern)) throw new Error("The optional email pattern must include {station_code} and {first_name} or {full_name}, followed by a valid domain.");
    const areaResult = await supabaseAdmin
      .from("workforce_amazon_service_areas")
      .select("service_area_id")
      .eq("company_id", companyId)
      .eq("station_code", serviceAreaCode)
      .maybeSingle();
    if (areaResult.error) throw new Error(areaResult.error.message);
    if (invitationEnabled && !areaResult.data?.service_area_id) throw new Error(`${serviceAreaCode} is not yet available in the Amazon service-area sync. Keep the station on hold until it is synced.`);
    const result = await supabaseAdmin.rpc("workforce_save_amazon_station", {
      p_company: companyId,
      p_actor: authorization.userId,
      p_actor_name: authorization.fullName || authorization.email || "OpsPulse",
      p_station: stationId,
      p_version: version,
      p_locations: authorization.hasAllLocationAccess ? null : stations.map((station) => station.id),
      p_settings: {
        service_area_code: serviceAreaCode,
        amazon_service_area_id: areaResult.data?.service_area_id || null,
        service_type: "Amazon Logistics",
        supervisor_alias: supervisorAlias,
        contract_type: contractType,
        associate_email_pattern: emailPattern || null,
        invitation_enabled: invitationEnabled
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
    let waitingForSync = 0;
    for (const station of stations) {
      const current = settingByStation.get(station.id);
      if (current) continue;
      const serviceAreaId = areaByCode.get(station.station_code.toUpperCase()) || null;
      if (!serviceAreaId) {
        waitingForSync += 1;
        continue;
      }
      const result = await supabaseAdmin.rpc("workforce_save_amazon_station", {
        p_company: companyId,
        p_actor: authorization.userId,
        p_actor_name: authorization.fullName || authorization.email || "OpsPulse",
        p_station: station.id,
        p_version: 0,
        p_locations: null,
        p_settings: {
          service_area_code: station.station_code.toUpperCase(),
          amazon_service_area_id: serviceAreaId,
          service_type: "Amazon Logistics",
          supervisor_alias: supervisorAlias,
          contract_type: "Independent Contractor",
          associate_email_pattern: null,
          invitation_enabled: true
        }
      });
      if (result.error) throw new Error(`${station.station_code}: ${result.error.message}`);
      updated += 1;
    }
    revalidateClientIdMaster();
    redirect(destination({ notice: `${updated} Amazon station${updated === 1 ? "" : "s"} configured with individual service areas.${waitingForSync ? ` ${waitingForSync} waiting for service-area sync.` : ""}` }));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(destination({ error: error instanceof Error ? error.message : "Unable to enable all Amazon stations." }));
  }
}

export async function refreshClientIdWorker() {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  try {
    if (authorization.readOnly) throw new Error("The worker check is unavailable in read-only mode.");
    const credentials = await callWorkforceAmazonWorker<{ workforce: boolean; idfy: boolean }>("/api/admin/credentials/status");
    if (!credentials.workforce || !credentials.idfy) {
      throw new Error(`Cloudflare credentials are incomplete: Amazon LSC ${credentials.workforce ? "ready" : "missing"}, IDfy ${credentials.idfy ? "ready" : "missing"}.`);
    }
    const session = await callWorkforceAmazonWorker<{ source?: string; associateCount?: number }>("/api/admin/workforce/session/ensure", {
      method: "POST",
      body: "{}"
    });
    const [areas, idfy] = await Promise.all([
      callWorkforceAmazonWorker<{ count?: number }>("/api/admin/amazon/service-areas/sync", { method: "POST", body: "{}" }),
      callWorkforceAmazonWorker<{ count?: number; insufficiencies?: number }>("/api/admin/idfy/sync", { method: "POST", body: "{}" })
    ]);
    revalidateClientIdMaster();
    redirect(destination({ notice: `Worker verified · ${session.associateCount ?? 0} Amazon associates · ${areas.count ?? 0} service areas · ${idfy.count ?? 0} IDfy profiles (${idfy.insufficiencies ?? 0} need attention).` }));
  } catch (error) {
    if (isRedirectError(error)) throw error;
    redirect(destination({ error: error instanceof Error ? error.message : "Unable to verify the shared Workforce worker." }));
  }
}
