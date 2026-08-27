import { NextRequest, NextResponse } from "next/server";
import {
  resolveCompanyPunchGeofence,
  resolveIntegrityFlag,
  TEMP_AUTO_APPROVE_ATTENDANCE_INTEGRITY
} from "@/lib/biometric/attendance-gps";
import {
  fileExtension,
  parseCoordinate,
  parseOptionalNumber,
  resolveConnectAttendanceWorker
} from "@/lib/connect-attendance-auth";
import { purgeSupportSelfieForReviewId } from "@/lib/purge-support-selfies";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const flagId = String(formData.get("flagId") ?? "").trim() || null;
    const punchId = String(formData.get("punchId") ?? "").trim() || null;
    const punchDate = String(formData.get("punchDate") ?? "").trim();
    const remarks = String(formData.get("remarks") ?? "").trim();
    const clientCapturedAt = String(formData.get("clientCapturedAt") ?? "").trim() || null;

    if (!accountId) throw new Error("Account is required.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(punchDate)) throw new Error("Attendance date is required.");
    const lat = parseCoordinate(formData.get("lat"), "Latitude");
    const lng = parseCoordinate(formData.get("lng"), "Longitude");
    const accuracyM = parseOptionalNumber(formData.get("accuracyM"));

    const selfie = formData.get("selfie");
    if (!(selfie instanceof File) || selfie.size <= 0) {
      throw new Error("Support selfie is required.");
    }
    if (selfie.size > 8 * 1024 * 1024) throw new Error("Selfie must be 8 MB or smaller.");

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType });

    const geofence = await resolveCompanyPunchGeofence({
      companyId: worker.companyId,
      preferredLocationId: worker.locationId,
      lat,
      lng
    });
    if (geofence.status === "outside") {
      const distanceLabel = geofence.distanceM != null ? `${Math.round(geofence.distanceM)}m` : "unknown distance";
      const allowedLabel = `${Math.round(geofence.radiusM)}m`;
      const station =
        geofence.station?.stationCode || geofence.station?.stationName || "station";
      throw new Error(
        `You are outside the allowed location (${distanceLabel} from ${station}, allowed ${allowedLabel}). Move inside the station perimeter to submit a support selfie.`
      );
    }
    if (geofence.status === "unknown") {
      throw new Error("Station geofence is not configured. Contact admin before submitting support evidence.");
    }

    if (flagId) {
      const flagResult = await supabaseAdmin
        .from("attendance_integrity_flags")
        .select("id, enrolment_id, status, punch_date, punch_id")
        .eq("id", flagId)
        .eq("company_id", worker.companyId)
        .maybeSingle();
      if (flagResult.error) throw new Error(flagResult.error.message);
      if (!flagResult.data) throw new Error("Integrity flag not found.");
      if (flagResult.data.enrolment_id !== worker.enrolmentId) {
        throw new Error("This flag does not belong to the signed-in account.");
      }
      if (flagResult.data.status !== "open") throw new Error("This flag is already closed.");
    }

    // Block duplicate submit before uploading another selfie.
    const existingQuery = supabaseAdmin
      .from("attendance_location_reviews")
      .select("id, status")
      .eq("company_id", worker.companyId)
      .eq("profile_type", worker.profileType)
      .eq("profile_id", worker.profileId)
      .eq("punch_date", punchDate)
      .in("status", ["pending", "returned"]);
    const existingResult = flagId
      ? await existingQuery.eq("flag_id", flagId).maybeSingle()
      : await existingQuery.is("flag_id", null).maybeSingle();
    if (existingResult.error && !String(existingResult.error.message).toLowerCase().includes("does not exist")) {
      throw new Error(existingResult.error.message);
    }
    if (existingResult.data?.status === "pending") {
      throw new Error("Support already submitted. Review is pending — you cannot send again.");
    }

    const safeName = selfie.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "support-selfie.jpg";
    const selfiePath = `${worker.companyId}/${worker.profileId}/attendance-support-${punchDate}-${Date.now()}${fileExtension(safeName) || ".jpg"}`;
    const uploadResult = await supabaseAdmin.storage
      .from("employee-profile-documents")
      .upload(selfiePath, Buffer.from(await selfie.arrayBuffer()), {
        contentType: selfie.type || "image/jpeg",
        upsert: false
      });
    if (uploadResult.error) throw new Error(uploadResult.error.message);

    const now = new Date().toISOString();

    // Support selfie is review-only: never insert attendance punches or rebuild daily.
    const payload = {
      company_id: worker.companyId,
      flag_id: flagId,
      punch_id: punchId,
      enrolment_id: worker.enrolmentId,
      profile_type: worker.profileType,
      profile_id: worker.profileId,
      punch_date: punchDate,
      selfie_path: selfiePath,
      lat,
      lng,
      accuracy_m: accuracyM,
      client_captured_at: clientCapturedAt,
      server_received_at: now,
      remarks: remarks || null,
      status: "pending",
      updated_at: now
    };

    const saveResult = existingResult.data?.id
      ? await supabaseAdmin
          .from("attendance_location_reviews")
          .update(payload)
          .eq("id", existingResult.data.id)
          .select("id, status, punch_date, flag_id")
          .single()
      : await supabaseAdmin
          .from("attendance_location_reviews")
          .insert(payload)
          .select("id, status, punch_date, flag_id")
          .single();
    if (saveResult.error) {
      if (String(saveResult.error.message).toLowerCase().includes("does not exist")) {
        throw new Error("Attendance GPS integrity setup is pending. Run attendance_gps_integrity_v1.sql.");
      }
      throw new Error(saveResult.error.message);
    }

    // Notify manager/HR in People only — do not mark attendance.
    const notifyFlagId = flagId || String(saveResult.data.flag_id || "");
    if (notifyFlagId && !TEMP_AUTO_APPROVE_ATTENDANCE_INTEGRITY) {
      const { notifyAttendanceFlagReviewers } = await import("@/lib/attendance-flag-notifications");
      await notifyAttendanceFlagReviewers({
        companyId: worker.companyId,
        profileType: worker.profileType,
        profileId: worker.profileId,
        punchDate,
        flagType: "support_selfie",
        message: "Support selfie submitted for flag approval — attendance unchanged until you approve.",
        flagId: notifyFlagId
      }).catch((error) => {
        console.error("Unable to notify reviewers of support selfie:", error);
      });
    }

    // TEMP: auto-approve so workers are not stuck waiting on manager review.
    if (TEMP_AUTO_APPROVE_ATTENDANCE_INTEGRITY && notifyFlagId) {
      await resolveIntegrityFlag(notifyFlagId, null).catch((error) => {
        console.error("TEMP auto-approve after support selfie failed", error);
      });
      await purgeSupportSelfieForReviewId(worker.companyId, String(saveResult.data.id)).catch(() => undefined);
      return NextResponse.json({
        ok: true,
        review: saveResult.data,
        attendanceMarked: true,
        message: "Selfie submitted and auto-approved (temporary development mode)."
      });
    }

    return NextResponse.json({
      ok: true,
      review: saveResult.data,
      attendanceMarked: false,
      message: "Selfie submitted. Review is pending."
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit support evidence.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
