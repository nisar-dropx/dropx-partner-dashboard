import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Deliberately the cheapest possible ping — one auth lookup, one upsert, nothing else. This
 * is what the native app's foreground service hits every ~30s for live-map purposes; it does
 * NOT do any of location-heartbeat's compliance work (geofence, integrity flags, outside-zone
 * duration) — that stays on its own slower cadence in that route, since compliance doesn't
 * need sub-minute resolution and this endpoint's whole reason to exist is to be cheap enough
 * to call far more often than that one without materially adding to Supabase load.
 */
export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    if (!accountId) throw new Error("Account is required.");

    const lat = Number(String(formData.get("lat") ?? "").trim());
    const lng = Number(String(formData.get("lng") ?? "").trim());
    if (!Number.isFinite(lat)) throw new Error("Latitude is required.");
    if (!Number.isFinite(lng)) throw new Error("Longitude is required.");
    const accuracyRaw = String(formData.get("accuracyM") ?? "").trim();
    const accuracyM = accuracyRaw ? Number(accuracyRaw) : null;
    const capturedAtRaw = String(formData.get("capturedAt") ?? "").trim();
    const capturedAt = capturedAtRaw ? new Date(capturedAtRaw) : new Date();
    if (Number.isNaN(capturedAt.getTime())) throw new Error("capturedAt is invalid.");

    // No requirePeopleScope here — this is a plain "who is this" lookup, not a portal-scope
    // gate, and skipping it avoids an extra designations query on every single call.
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });
    if (worker.profileType !== "employee" && worker.profileType !== "contractor") {
      return NextResponse.json({ ok: true, skipped: true, reason: "unsupported_profile_type" });
    }

    const upsert = await supabaseAdmin
      .from("worker_live_positions")
      .upsert(
        {
          company_id: worker.companyId,
          profile_type: worker.profileType,
          account_id: worker.profileId,
          lat,
          lng,
          accuracy_m: Number.isFinite(accuracyM as number) ? accuracyM : null,
          captured_at: capturedAt.toISOString(),
          updated_at: new Date().toISOString()
        },
        { onConflict: "company_id,profile_type,account_id" }
      );
    if (upsert.error) {
      if (String(upsert.error.message).toLowerCase().includes("does not exist")) {
        throw new Error("Live position setup is pending. Run worker_live_positions_v1.sql.");
      }
      throw new Error(upsert.error.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record live position.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
