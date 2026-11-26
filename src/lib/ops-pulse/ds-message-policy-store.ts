import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  fallbackDsMessagePolicy,
  type DsMessagePolicy
} from "@/lib/ops-pulse/ds-message-policy";

export type DsMessagePolicyWithMeta = DsMessagePolicy & {
  id: string;
  label: string;
  description: string | null;
  updatedAt: string;
};

type TypeMeta = { code: string; label: string; description: string | null };
type PolicyRow = {
  id: string;
  company_id: string;
  message_type: string;
  urgency: string;
  frequency: string;
  cooldown_minutes: number;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  threshold_seconds: number | null;
  enabled: boolean;
  version: number;
  updated_at: string;
  ds_message_types?: TypeMeta | TypeMeta[] | null;
};

function db() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

function typeMetaFromRow(row: PolicyRow): TypeMeta | null {
  const raw = row.ds_message_types;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

function mapRow(row: PolicyRow): DsMessagePolicyWithMeta {
  const typeMeta = typeMetaFromRow(row);
  return {
    id: row.id,
    messageType: row.message_type,
    urgency: row.urgency as DsMessagePolicy["urgency"],
    frequency: row.frequency as DsMessagePolicy["frequency"],
    cooldownMinutes: Number(row.cooldown_minutes ?? 0),
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    thresholdSeconds: row.threshold_seconds != null ? Number(row.threshold_seconds) : null,
    enabled: row.enabled === true,
    version: Number(row.version ?? 1),
    label: typeMeta?.label ?? row.message_type,
    description: typeMeta?.description ?? null,
    updatedAt: row.updated_at
  };
}

/** All message policies for a company, joined with type catalogue labels. */
export async function loadDsMessagePolicies(companyId: string): Promise<DsMessagePolicyWithMeta[]> {
  const { data, error } = await db()
    .from("ds_message_policies")
    .select(
      "id,company_id,message_type,urgency,frequency,cooldown_minutes,quiet_start_minute,quiet_end_minute,threshold_seconds,enabled,version,updated_at,ds_message_types(code,label,description)"
    )
    .eq("company_id", companyId)
    .order("message_type");
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as PolicyRow[]).map(mapRow);
}

export async function getDsMessagePolicy(companyId: string, messageType: string): Promise<DsMessagePolicy> {
  const { data, error } = await db()
    .from("ds_message_policies")
    .select(
      "id,company_id,message_type,urgency,frequency,cooldown_minutes,quiet_start_minute,quiet_end_minute,threshold_seconds,enabled,version,updated_at,ds_message_types(code,label,description)"
    )
    .eq("company_id", companyId)
    .eq("message_type", messageType)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return fallbackDsMessagePolicy(messageType);
  return mapRow(data as unknown as PolicyRow);
}

export async function recordDsMessageSend(
  companyId: string,
  messageType: string,
  stationCode: string | null | undefined,
  policyVersion: number,
  dedupeKey?: string | null,
  meta?: Record<string, unknown>
): Promise<void> {
  const station = stationCode?.trim() ? stationCode.trim().toUpperCase() : null;
  const { error } = await db().from("ds_message_send_log").insert({
    company_id: companyId,
    message_type: messageType,
    station_code: station,
    policy_version: policyVersion,
    dedupe_key: dedupeKey?.trim() ? dedupeKey.trim() : null,
    meta_json: meta ?? {}
  });
  if (error) throw new Error(error.message);
}

export async function lastDsMessageSentAt(
  companyId: string,
  messageType: string,
  stationCode?: string | null
): Promise<number | null> {
  let query = db()
    .from("ds_message_send_log")
    .select("sent_at")
    .eq("company_id", companyId)
    .eq("message_type", messageType)
    .order("sent_at", { ascending: false })
    .limit(1);
  const station = stationCode?.trim() ? stationCode.trim().toUpperCase() : null;
  if (station) query = query.eq("station_code", station);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.sent_at) return null;
  const ms = new Date(data.sent_at as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export type DsMessagePolicyUpdate = {
  id: string;
  urgency: DsMessagePolicy["urgency"];
  frequency: DsMessagePolicy["frequency"];
  cooldownMinutes: number;
  thresholdSeconds: number | null;
  enabled: boolean;
};

/** Persists policy edits and bumps version. Requires an existing row id for this company. */
export async function updateDsMessagePolicy(
  companyId: string,
  input: DsMessagePolicyUpdate
): Promise<DsMessagePolicyWithMeta> {
  const current = await db()
    .from("ds_message_policies")
    .select("id,version,company_id")
    .eq("id", input.id)
    .eq("company_id", companyId)
    .maybeSingle();
  if (current.error) throw new Error(current.error.message);
  if (!current.data) throw new Error("Policy not found.");

  const nextVersion = Number(current.data.version ?? 1) + 1;
  const { data, error } = await db()
    .from("ds_message_policies")
    .update({
      urgency: input.urgency,
      frequency: input.frequency,
      cooldown_minutes: Math.max(0, Math.floor(input.cooldownMinutes)),
      threshold_seconds: input.thresholdSeconds,
      enabled: input.enabled,
      version: nextVersion,
      updated_at: new Date().toISOString()
    })
    .eq("id", input.id)
    .eq("company_id", companyId)
    .select(
      "id,company_id,message_type,urgency,frequency,cooldown_minutes,quiet_start_minute,quiet_end_minute,threshold_seconds,enabled,version,updated_at,ds_message_types(code,label,description)"
    )
    .single();
  if (error) throw new Error(error.message);
  return mapRow(data as unknown as PolicyRow);
}