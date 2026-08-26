import { NextRequest, NextResponse } from "next/server";
import {
  fileExtension,
  parseCoordinate,
  parseOptionalNumber,
  resolveConnectAttendanceWorker
} from "@/lib/connect-attendance-auth";
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

    if (flagId) {
      const flagResult = await supabaseAdmin
        .from("attendance_integrity_flags")
        .select("id, enrolment_id, status, punch_date")
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
      throw new Error("A support package is already pending review for this date.");
    }

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
          .select("id, status, punch_date")
          .single()
      : await supabaseAdmin
          .from("attendance_location_reviews")
          .insert(payload)
          .select("id, status, punch_date")
          .single();
    if (saveResult.error) {
      if (String(saveResult.error.message).toLowerCase().includes("does not exist")) {
        throw new Error("Attendance GPS integrity setup is pending. Run attendance_gps_integrity_v1.sql.");
      }
      throw new Error(saveResult.error.message);
    }

    return NextResponse.json({
      ok: true,
      review: saveResult.data
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit support evidence.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
