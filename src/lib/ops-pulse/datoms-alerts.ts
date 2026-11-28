import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { AuthorizationContext } from "@/lib/authorization";
import { loadReportBotSettings } from "@/lib/report-bot/settings";
import { darkStoreScope } from "@/lib/ops-pulse/dark-store";

export type DatomsAlertLevel = "L1" | "L2" | "L3";

export type DatomsAlertRow = {
  id: string;
  station_code: string;
  level: DatomsAlertLevel;
  title: string | null;
  site_name: string | null;
  asset_name: string | null;
  room_type: string | null;
  alert_text: string | null;
  generated_at: string;
  notified_at: string | null;
  rule_name: string | null;
};

export type DatomsThingRow = {
  id: string;
  thing_id: string;
  station_code: string | null;
  name: string;
  category: string | null;
  site_name: string | null;
  online: boolean | null;
  metrics_json: Record<string, unknown>;
  status_json: Record<string, unknown>;
  observed_at: string;
};

export type DatomsReportRow = {
  id: string;
  report_key: string;
  station_code: string | null;
  title: string | null;
  kind: string;
  payload_json: Record<string, unknown>;
  observed_at: string;
};

/** Same allowlist as the Datoms worker war rooms. */
export const DATOMS_STATIONS = new Set([
  "TCC3", "TCD4", "TTB3", "TTA5", "TZC4", "TTG9", "TFB7"
]);

const COMPANY_ID = "43866344-b550-4e8a-9a2d-9d23f3d8a997";

type DatomsRunPoll = (
  env: Record<string, unknown>,
  options?: { dryRun?: boolean; allowLogin?: boolean; catchUp?: boolean }
) => Promise<Record<string, unknown>>;

type DatomsKeepAlive = (env: Record<string, unknown>) => Promise<Record<string, unknown>>;
type DatomsSnapshotFn = (
  env: Record<string, unknown>,
  options?: { allowLogin?: boolean }
) => Promise<Record<string, unknown>>;

function serviceDb() {
  const url = process.env.COMPANY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("Supabase is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Station codes the user may see, intersected with Datoms-enabled stores. */
export async function datomsScopedStationCodes(authorization: AuthorizationContext): Promise<string[]> {
  const scope = await darkStoreScope(authorization);
  const codes = scope.locations
    .map((l) => String(l.station_code ?? "").trim().toUpperCase())
    .filter((code) => DATOMS_STATIONS.has(code));
  return [...new Set(codes)].sort();
}

export async function loadDatomsAlerts(
  authorization: AuthorizationContext,
  { limit = 200 }: { limit?: number } = {}
): Promise<DatomsAlertRow[]> {
  const companyId = authorization.companyId;
  if (!companyId) return [];
  const stations = await datomsScopedStationCodes(authorization);
  if (!stations.length) return [];
  const db = serviceDb();
  const { data, error } = await db
    .from("ds_datoms_alerts")
    .select("id,station_code,level,title,site_name,asset_name,room_type,alert_text,generated_at,notified_at,rule_name")
    .eq("company_id", companyId)
    .in("station_code", stations)
    .order("generated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DatomsAlertRow[];
}

export async function loadDatomsThings(
  authorization: AuthorizationContext,
  { limit = 200 }: { limit?: number } = {}
): Promise<DatomsThingRow[]> {
  const companyId = authorization.companyId;
  if (!companyId) return [];
  const stations = await datomsScopedStationCodes(authorization);
  if (!stations.length) return [];
  const db = serviceDb();
  const { data, error } = await db
    .from("ds_datoms_things_snapshot")
    .select("id,thing_id,station_code,name,category,site_name,online,metrics_json,status_json,observed_at")
    .eq("company_id", companyId)
    .in("station_code", stations)
    .order("name", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DatomsThingRow[];
}

export async function loadDatomsThing(
  authorization: AuthorizationContext,
  thingId: string
): Promise<DatomsThingRow | null> {
  const companyId = authorization.companyId;
  const id = String(thingId ?? "").trim();
  if (!companyId || !id) return null;
  const stations = await datomsScopedStationCodes(authorization);
  if (!stations.length) return null;
  const db = serviceDb();
  const { data, error } = await db
    .from("ds_datoms_things_snapshot")
    .select("id,thing_id,station_code,name,category,site_name,online,metrics_json,status_json,observed_at")
    .eq("company_id", companyId)
    .eq("thing_id", id)
    .maybeSingle();
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return null;
    throw new Error(error.message);
  }
  if (!data) return null;
  const row = data as DatomsThingRow;
  if (!row.station_code || !stations.includes(String(row.station_code).toUpperCase())) return null;
  return row;
}

export async function loadDatomsReports(
  authorization: AuthorizationContext
): Promise<DatomsReportRow[]> {
  const companyId = authorization.companyId;
  if (!companyId) return [];
  // Reports are org-level; still require Datoms station access so empty-scope users see nothing.
  const stations = await datomsScopedStationCodes(authorization);
  if (!stations.length) return [];
  const db = serviceDb();
  const { data, error } = await db
    .from("ds_datoms_report_cache")
    .select("id,report_key,station_code,title,kind,payload_json,observed_at")
    .eq("company_id", companyId)
    .order("observed_at", { ascending: false })
    .limit(40);
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DatomsReportRow[];
}

export function datomsCredentialsConfigured() {
  const email = (process.env.DATOMS_EMAIL || process.env.DATOMS_ID || "").trim();
  const password = (
    process.env.DATOMS_PASSWORD_NEW ||
    process.env.DATOMS_PASSWORD ||
    process.env.DATOMS_PASSWORD_HASH ||
    ""
  ).trim();
  return Boolean(email && password);
}

/** @deprecated Prefer datomsCredentialsConfigured — CF worker URL is no longer required for polls. */
export function datomsWorkerConfigured() {
  return datomsCredentialsConfigured();
}

async function portalDatomsEnv() {
  const settings = await loadReportBotSettings(COMPANY_ID);
  return {
    DATOMS_EMAIL: process.env.DATOMS_EMAIL || process.env.DATOMS_ID || "",
    DATOMS_PASSWORD:
      process.env.DATOMS_PASSWORD_NEW ||
      process.env.DATOMS_PASSWORD ||
      process.env.DATOMS_PASSWORD_HASH ||
      "",
    DATOMS_CUSTOMER_ID: process.env.DATOMS_CUSTOMER_ID || "17428",
    DATOMS_APPLICATION_ID: process.env.DATOMS_APPLICATION_ID || "16",
    DATOMS_ALLOW_LOGIN: process.env.DATOMS_ALLOW_LOGIN || "1",
    COMPANY_ID,
    SUPABASE_URL: process.env.COMPANY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    SUPABASE_SERVICE_ROLE_KEY:
      process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    COMPANY_SUPABASE_URL: process.env.COMPANY_SUPABASE_URL || "",
    COMPANY_SUPABASE_SERVICE_ROLE_KEY: process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || "",
    REPORT_BOT_URL: settings.worker_url || process.env.REPORT_BOT_URL || "",
    REPORT_BOT_TOKEN: settings.worker_token || process.env.REPORT_BOT_TOKEN || "",
    ALERT_DEDUPE: null
  };
}

/**
 * Run the Datoms poll on OpsPulse (India egress).
 * Manual UI calls use allowLogin:false so they never burn /accounts/login.
 */
export async function runPortalDatomsPoll(options?: {
  dryRun?: boolean;
  allowLogin?: boolean;
  catchUp?: boolean;
}) {
  if (!datomsCredentialsConfigured()) {
    throw new Error("DATOMS_EMAIL and DATOMS_PASSWORD are not configured on OpsPulse.");
  }
  const workerMod = (await import("../../../workers/datoms-alerts/src/index.mjs")) as unknown as {
    runPoll: DatomsRunPoll;
  };
  const env = await portalDatomsEnv();
  return workerMod.runPoll(env, {
    dryRun: options?.dryRun === true,
    allowLogin: options?.allowLogin === true,
    catchUp: options?.catchUp === true
  });
}

/** Manual cold-chain / alerts button — session reuse only, never login. Pulls up to 6h. */
export async function triggerDatomsPoll() {
  return runPortalDatomsPoll({ allowLogin: false, catchUp: true });
}

/** Ping Datoms with the stored token so the session does not idle-expire. Never logs in. */
export async function runPortalDatomsKeepAlive() {
  if (!datomsCredentialsConfigured()) {
    throw new Error("DATOMS_EMAIL and DATOMS_PASSWORD are not configured on OpsPulse.");
  }
  const workerMod = (await import("../../../workers/datoms-alerts/src/index.mjs")) as unknown as {
    runKeepAlive: DatomsKeepAlive;
  };
  const env = await portalDatomsEnv();
  return workerMod.runKeepAlive(env);
}

export async function runPortalDatomsThingsSnapshot(options?: { allowLogin?: boolean }) {
  if (!datomsCredentialsConfigured()) {
    throw new Error("DATOMS_EMAIL and DATOMS_PASSWORD are not configured on OpsPulse.");
  }
  const workerMod = (await import("../../../workers/datoms-alerts/src/index.mjs")) as unknown as {
    runThingsSnapshot: DatomsSnapshotFn;
  };
  return workerMod.runThingsSnapshot(await portalDatomsEnv(), {
    allowLogin: options?.allowLogin === true
  });
}

export async function runPortalDatomsReportsSnapshot(options?: { allowLogin?: boolean }) {
  if (!datomsCredentialsConfigured()) {
    throw new Error("DATOMS_EMAIL and DATOMS_PASSWORD are not configured on OpsPulse.");
  }
  const workerMod = (await import("../../../workers/datoms-alerts/src/index.mjs")) as unknown as {
    runReportsSnapshot: DatomsSnapshotFn;
  };
  return workerMod.runReportsSnapshot(await portalDatomsEnv(), {
    allowLogin: options?.allowLogin === true
  });
}
