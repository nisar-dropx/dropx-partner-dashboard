import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * A worker's own location-integrity "flag" submissions — the selfie + GPS
 * support package they send in when a punch is flagged outside the station
 * geofence. Queried directly so it shows up in "My Requests" without
 * depending on the dashboard app's own deployment.
 */
export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    if (!accountId) throw new Error("Account is required.");
    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });

    const result = await supabaseAdmin
      .from("attendance_location_reviews")
      .select("id, punch_date, status, remarks, review_remarks, accuracy_m, created_at, reviewed_at")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (result.error) {
      if (/does not exist|schema cache/i.test(result.error.message)) return NextResponse.json({ flags: [] });
      throw new Error(result.error.message);
    }

    return NextResponse.json({
      flags: (result.data ?? []).map((item) => ({
        id: item.id,
        punchDate: item.punch_date,
        status: item.status,
        remarks: item.remarks,
        reviewRemarks: item.review_remarks,
        accuracyM: item.accuracy_m,
        createdAt: item.created_at,
        reviewedAt: item.reviewed_at
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load location checks." }, { status: 400 });
  }
}
