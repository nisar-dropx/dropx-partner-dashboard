/**
 * Clock-out enforcement for SI handover.
 * Mode is read from Ops Masters → SI Handover Master (`settings.clockOutMode`).
 * Connect attendance should call `resolveSiHandoverClockOut` when hard_block is enabled.
 */
import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  normalizeSettings,
  shouldBlockAttendanceOutPunch,
  type ClockOutMode,
  type Settings,
} from "./model";

export type ClockOutDecision = {
  mode: ClockOutMode;
  block: boolean;
  warn: boolean;
  reason: string | null;
  checklistId: string | null;
};

const clear = (mode: ClockOutMode): ClockOutDecision => ({
  mode,
  block: false,
  warn: false,
  reason: null,
  checklistId: null,
});

async function loadSettings(companyId: string): Promise<Settings | null> {
  if (!supabaseAdmin) return null;
  const r = await supabaseAdmin
    .from("ops_si_handover_master")
    .select("settings")
    .eq("company_id", companyId)
    .maybeSingle();
  if (r.error || !r.data) return null;
  return normalizeSettings(r.data.settings);
}

/**
 * Returns whether an out-punch / end-shift should be blocked or warned.
 * Safe to call from Connect punch routes once hard_block is turned on in master.
 */
export async function resolveSiHandoverClockOut(input: {
  companyId: string;
  userId: string;
  locationId?: string | null;
}): Promise<ClockOutDecision> {
  const settings = await loadSettings(input.companyId);
  if (!settings) return clear("ops_only");
  const mode = settings.clockOutMode;
  if (mode === "ops_only") return clear(mode);
  if (!supabaseAdmin) return clear(mode);

  let q = supabaseAdmin
    .from("ops_si_shift_checklists")
    .select("id,status,store_code,shift_date,shift_slot")
    .eq("company_id", input.companyId)
    .eq("outgoing_user_id", input.userId)
    .is("deleted_at", null)
    .in("status", ["open", "submitted", "rejected"])
    .order("shift_date", { ascending: false })
    .limit(1);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  const r = await q.maybeSingle();
  if (r.error || !r.data) return clear(mode);

  const label = `${r.data.store_code} · ${r.data.shift_date} ${r.data.shift_slot}`;
  const pending =
    r.data.status === "submitted"
      ? `Handover for ${label} is awaiting acceptance by the incoming Shift Incharge.`
      : `Complete and submit the SI handover for ${label} before ending the shift.`;

  if (mode === "soft_warn") {
    return {
      mode,
      block: false,
      warn: true,
      reason: pending,
      checklistId: r.data.id,
    };
  }
  // hard_block
  if (!shouldBlockAttendanceOutPunch(settings)) return clear(mode);
  return {
    mode,
    block: true,
    warn: false,
    reason: pending,
    checklistId: r.data.id,
  };
}
