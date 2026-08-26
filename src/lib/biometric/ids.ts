import { supabaseAdmin } from "@/lib/supabase-admin";

function numericId(value: unknown) {
  const text = String(value ?? "").replace(/\D/g, "");
  if (!/^\d{1,20}$/.test(text)) return null;
  return Number(text);
}

async function loadNumericIds(companyId: string, table: string, column: string) {
  if (!supabaseAdmin) return [] as number[];
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(column)
    .eq("company_id", companyId)
    .not(column, "is", null);
  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("schema cache")) return [];
    throw new Error(error.message);
  }
  return (data ?? [])
    .map((row) => numericId((row as unknown as Record<string, unknown>)[column]))
    .filter((value): value is number => value !== null);
}

async function loadEnrolmentStartNumber(companyId: string) {
  if (!supabaseAdmin) return 1;
  const { data, error } = await supabaseAdmin
    .from("biometric_middleware_settings")
    .select("enrolment_start_number")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes("does not exist") || message.includes("schema cache")) return 1;
    throw new Error(error.message);
  }
  const start = Number((data as { enrolment_start_number?: unknown } | null)?.enrolment_start_number);
  return Number.isInteger(start) && start > 0 ? start : 1;
}

export async function generateBiometricEnrolmentId(companyId: string) {
  const [enrolments, employees, fieldExecutives, contractors, vendors, workers, helpers, pickers, startNumber] = await Promise.all([
    loadNumericIds(companyId, "biometric_enrolments", "enrolment_id"),
    loadNumericIds(companyId, "employees", "biometric_id"),
    loadNumericIds(companyId, "field_executives", "biometric_id"),
    loadNumericIds(companyId, "contractors", "biometric_id"),
    loadNumericIds(companyId, "vendors", "biometric_id"),
    loadNumericIds(companyId, "workers", "biometric_id"),
    loadNumericIds(companyId, "workforce_helpers", "biometric_id"),
    loadNumericIds(companyId, "workforce_pickers", "biometric_id"),
    loadEnrolmentStartNumber(companyId)
  ]);

  const used = new Set([...enrolments, ...employees, ...fieldExecutives, ...contractors, ...vendors, ...workers, ...helpers, ...pickers]);
  const normalSeries = Array.from(used).filter((value) => value > 0 && value < 9000);
  let next = Math.max(startNumber - 1, ...normalSeries) + 1;
  while (used.has(next)) next += 1;
  return String(next);
}
