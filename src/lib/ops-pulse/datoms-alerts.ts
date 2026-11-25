import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { AuthorizationContext } from "@/lib/authorization";

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

export function datomsWorkerConfigured() {
  const url = (process.env.DATOMS_ALERTS_WORKER_URL || "").trim();
  const key = (process.env.DATOMS_ALERTS_ADMIN_KEY || process.env.CASH_RECON_ADMIN_KEY || "").trim();
  return Boolean(url && key);
}

export async function triggerDatomsPoll() {
  const base = (process.env.DATOMS_ALERTS_WORKER_URL || "").trim().replace(/\/$/, "");
  const key = (process.env.DATOMS_ALERTS_ADMIN_KEY || process.env.CASH_RECON_ADMIN_KEY || "").trim();
  if (!base || !key) throw new Error("Datoms alerts worker is not configured.");
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store"
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : text.slice(0, 200);
    throw new Error(msg || `Worker ${res.status}`);
  }
  return body;
}
