import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { AuthorizationContext } from "@/lib/authorization";
import { loadReportBotSettings } from "@/lib/report-bot/settings";

export type DatomsAlertRow = {
  id: string;
  station_code: string;
  level: "L2" | "L3";
  title: string | null;
  site_name: string | null;
  asset_name: string | null;
  room_type: string | null;
  alert_text: string | null;
  generated_at: string;
  notified_at: string | null;
  rule_name: string | null;
};

const COMPANY_ID = "43866344-b550-4e8a-9a2d-9d23f3d8a997";

type DatomsRunPoll = (
  env: Record<string, unknown>,
  options?: { dryRun?: boolean; allowLogin?: boolean }
) => Promise<Record<string, unknown>>;

function serviceDb() {
  const url = process.env.COMPANY_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.COMPANY_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("Supabase is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function loadDatomsAlerts(
  authorization: AuthorizationContext,
  { limit = 80 }: { limit?: number } = {}
): Promise<DatomsAlertRow[]> {
  const companyId = authorization.companyId;
  if (!companyId) return [];
  const db = serviceDb();
  const { data, error } = await db
    .from("ds_datoms_alerts")
    .select("id,station_code,level,title,site_name,asset_name,room_type,alert_text,generated_at,notified_at,rule_name")
    .eq("company_id", companyId)
    .order("generated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));
  if (error) {
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DatomsAlertRow[];
}

export function datomsCredentialsConfigured() {
  const email = (process.env.DATOMS_EMAIL || process.env.DATOMS_ID || "").trim();
  const password = (process.env.DATOMS_PASSWORD || process.env.DATOMS_PASSWORD_HASH || "").trim();
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
    DATOMS_PASSWORD: process.env.DATOMS_PASSWORD || process.env.DATOMS_PASSWORD_HASH || "",
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
export async function runPortalDatomsPoll(options?: { dryRun?: boolean; allowLogin?: boolean }) {
  if (!datomsCredentialsConfigured()) {
    throw new Error("DATOMS_EMAIL and DATOMS_PASSWORD are not configured on OpsPulse.");
  }
  const workerMod = await import("../../../workers/datoms-alerts/src/index.mjs");
  const runPoll = (workerMod as { runPoll: DatomsRunPoll }).runPoll;
  const env = await portalDatomsEnv();
  return runPoll(env, {
    dryRun: options?.dryRun === true,
    allowLogin: options?.allowLogin === true
  });
}

/** Manual cold-chain button — session reuse only, never login. */
export async function triggerDatomsPoll() {
  return runPortalDatomsPoll({ allowLogin: false });
}
