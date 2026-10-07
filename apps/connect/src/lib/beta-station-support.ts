import type { SupabaseClient } from "@supabase/supabase-js";

export type BetaSupport = {
  stationCode: string | null;
  stationState: string | null;
  leader: { name: string; phone: string | null } | null;
};

export function supportPhone(value: unknown, countryCode: unknown = "91"): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || !/^[+\d\s()-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  const country = String(countryCode ?? "91").replace(/\D/g, "") || "91";
  const full = raw.startsWith("+") ? digits : digits.length === 10 ? country + digits : digits;
  return /^[1-9]\d{7,14}$/.test(full) ? `+${full}` : null;
}

// Read only: resolve the exact beta candidate's station and its configured active leader.
export async function loadBetaStationSupport(db: SupabaseClient, companyId: string, candidateId: string): Promise<BetaSupport> {
  const candidate = await db.from("workforce_amazon_email_pilot_candidates")
    .select("station_id").eq("company_id", companyId).eq("id", candidateId).is("closed_at", null).maybeSingle();
  if (candidate.error || !candidate.data) throw new Error("Private beta candidate unavailable.");
  const station = await db.from("stations").select("station_code,state,station_manager_email")
    .eq("company_id", companyId).eq("id", candidate.data.station_id).maybeSingle();
  if (station.error) throw new Error("Station contact is temporarily unavailable.");
  const result: BetaSupport = { stationCode: station.data?.station_code ?? null, stationState: station.data?.state ?? null, leader: null };
  const email = String(station.data?.station_manager_email ?? "").trim();
  if (!email) return result;
  const manager = await db.from("profiles").select("full_name,mobile,mobile_country_code,phone")
    .eq("company_id", companyId).eq("is_active", true).ilike("email", email.replace(/[\\%_]/g, "\\$&")).maybeSingle();
  if (manager.error) throw new Error("Team leader contact is temporarily unavailable.");
  if (manager.data?.full_name) result.leader = {
    name: manager.data.full_name,
    phone: supportPhone(manager.data.mobile, manager.data.mobile_country_code) ?? supportPhone(manager.data.phone, manager.data.mobile_country_code)
  };
  return result;
}
