import "server-only";
import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { BotMode } from "@/lib/report-bot/logic";

export type ReportBotSettings = {
  company_id: string;
  mode: BotMode;
  timezone: string;
  worker_url: string | null;
  worker_token: string | null;
  worker_token_hash: string | null;
  worker_token_created_at: string | null;
  ai_provider: "gemini" | "anthropic" | "openai";
  ai_model: string;
  ai_effort: "low" | "medium" | "high";
  approval_mode: "manual" | "auto";
  auto_send_min_confidence: number;
  reply_delay_min_seconds: number;
  reply_delay_max_seconds: number;
  group_min_gap_seconds: number;
  max_reminder_delay_minutes: number;
  include_own_messages: boolean;
  accept_without_request: boolean;
  feedback_language: string;
  feedback_template: string;
  label_pass: string;
  label_fail: string;
  label_review: string;
  max_feedback_chars: number;
  connection_state: string;
  connected_number: string | null;
  connected_name: string | null;
  connection_error: string | null;
  last_worker_seen_at: string | null;
  updated_at: string;
};

export function reportBotDb() {
  if (!supabaseAdmin) throw new Error("Report Bot is unavailable: the database service key is not configured.");
  return supabaseAdmin;
}

function normalizeSettings(row: Record<string, unknown>): ReportBotSettings {
  return { ...(row as ReportBotSettings), auto_send_min_confidence: Number(row.auto_send_min_confidence ?? 0.85) };
}

/** Loads the company's settings, creating the default row (mode off) on first use. */
export async function loadReportBotSettings(companyId: string): Promise<ReportBotSettings> {
  const db = reportBotDb();
  const existing = await db.from("report_bot_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return normalizeSettings(existing.data);
  const created = await db.from("report_bot_settings")
    .upsert({ company_id: companyId }, { onConflict: "company_id", ignoreDuplicates: true })
    .select("*")
    .maybeSingle();
  if (created.error) throw new Error(created.error.message);
  if (created.data) return normalizeSettings(created.data);
  const reread = await db.from("report_bot_settings").select("*").eq("company_id", companyId).single();
  if (reread.error) throw new Error(reread.error.message);
  return normalizeSettings(reread.data);
}

export function hashWorkerToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateWorkerToken() {
  return `rbw_${randomBytes(32).toString("base64url")}`;
}

/** Resolves which company a worker belongs to from its bearer token. */
export async function settingsForWorkerRequest(request: Request): Promise<ReportBotSettings | null> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token.length < 20) return null;
  const db = reportBotDb();
  const result = await db.from("report_bot_settings").select("*").eq("worker_token_hash", hashWorkerToken(token)).maybeSingle();
  if (result.error || !result.data) return null;
  return normalizeSettings(result.data);
}

const AI_KEY_ENV: Record<ReportBotSettings["ai_provider"], string> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY"
};

export function aiKeyName(provider: ReportBotSettings["ai_provider"]) {
  return AI_KEY_ENV[provider] ?? "GEMINI_API_KEY";
}

export function aiKeyConfigured(provider: ReportBotSettings["ai_provider"]) {
  return Boolean(process.env[aiKeyName(provider)]?.trim());
}

export function aiProviderLabel(provider: ReportBotSettings["ai_provider"]) {
  return provider === "gemini" ? "Gemini" : provider === "anthropic" ? "Claude" : "OpenAI";
}
