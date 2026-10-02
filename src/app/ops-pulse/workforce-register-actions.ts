"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { filterOnboardingLocations } from "@/lib/onboarding-location-access";
import { supabaseAdmin } from "@/lib/supabase-admin";

type InterviewOutcome = "reported" | "did_not_report" | "not_responding" | "not_interested" | "rescheduled";

function value(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error &&
    String((error as { digest?: unknown }).digest ?? "").startsWith("NEXT_REDIRECT");
}

function validDateTime(value: string) {
  if (!value) return null;
  // datetime-local carries no timezone. Operations schedules in IST.
  const parsed = new Date(`${value.length === 16 ? value : value.slice(0, 16)}:00+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function destination(params: Record<string, string | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, item] of Object.entries(params)) if (item) query.set(key, item);
  return `/work-force-register${query.size ? `?${query.toString()}` : ""}`;
}

async function scopedLead(leadId: string) {
  const authorization = await requirePagePermission("delivery_associates", "edit");
  const companyId = requireCompanyId(authorization);
  if (authorization.readOnly || !supabaseAdmin) throw new Error("Editing is unavailable in this view.");

  const leadResult = await supabaseAdmin.from("recruitment_leads")
    .select("id, location_id, status, follow_up_at, recruitment_locations(station_id)")
    .eq("company_id", companyId)
    .eq("id", leadId)
    .eq("stream", "workforce")
    .eq("archived", false)
    .maybeSingle();
  if (leadResult.error) throw new Error(leadResult.error.message);
  if (!leadResult.data) throw new Error("Recruit candidate was not found.");
  const lead = leadResult.data;

  if (!authorization.hasAllLocationAccess) {
    const stationResult = await supabaseAdmin.from("stations").select("id, station_code, hide_from_location_list, parent_station_id").eq("company_id", companyId).limit(500);
    if (stationResult.error) throw new Error(stationResult.error.message);
    const allowedIds = new Set(filterOnboardingLocations(stationResult.data ?? [], authorization).map((station) => station.id));
    const locationRelation = Array.isArray(lead.recruitment_locations) ? lead.recruitment_locations[0] : lead.recruitment_locations;
    if (!locationRelation?.station_id || !allowedIds.has(locationRelation.station_id)) {
      throw new Error("This candidate is outside your station scope.");
    }
  }

  return { authorization, companyId, lead };
}

export async function updateRecruitInterviewOutcome(formData: FormData) {
  const leadId = value(formData, "lead_id");
  const outcome = value(formData, "outcome") as InterviewOutcome;
  const note = value(formData, "note");
  const requestedDate = value(formData, "rescheduled_for");
  let redirectTo = destination({ tab: "interviews", date: value(formData, "queue_date") || null });

  try {
    if (!leadId) throw new Error("Choose a candidate.");
    if (!["reported", "did_not_report", "not_responding", "not_interested", "rescheduled"].includes(outcome)) throw new Error("Choose a valid interview update.");

    const { authorization, companyId, lead } = await scopedLead(leadId);
    const database = supabaseAdmin;
    if (!database) throw new Error("The Workforce Register service is unavailable.");
    const now = new Date();
    const updateAt = now.toISOString();
    let status = "";
    let finalStatus = "";
    let interviewAt: string | null = null;
    let eventCode = "";

    if (outcome === "reported") {
      status = "joined";
      finalStatus = "Reported";
      eventCode = "joined";
      redirectTo = destination({ tab: "dropx-id", candidate: leadId, notice: "Candidate reported. Send the DropX ID invitation to start registration." });
    } else if (outcome === "did_not_report") {
      status = "interview_no_show";
      finalStatus = "Did not report";
      eventCode = "interview_no_show";
      redirectTo = destination({ tab: "interviews", date: value(formData, "queue_date") || null, notice: "Candidate marked as did not report. Recruit has been updated." });
    } else if (outcome === "not_responding") {
      status = "no_response";
      finalStatus = "Not responding";
      eventCode = "interview_not_responding";
      redirectTo = destination({ tab: "interviews", date: value(formData, "queue_date") || null, notice: "Candidate marked as not responding. Recruit has been updated." });
    } else if (outcome === "not_interested") {
      status = "not_interested";
      finalStatus = "Not interested";
      eventCode = "interview_not_interested";
      redirectTo = destination({ tab: "interviews", date: value(formData, "queue_date") || null, notice: "Candidate moved out of the active interview queue." });
    } else {
      const parsed = validDateTime(requestedDate);
      if (!parsed || parsed.getTime() <= now.getTime()) {
        throw new Error("Choose a future interview date and time to reschedule this candidate.");
      }
      status = "interview_scheduled";
      finalStatus = "Rescheduled";
      interviewAt = parsed.toISOString();
      eventCode = "interview_rescheduled";
      redirectTo = destination({ tab: "interviews", date: requestedDate.slice(0, 10), notice: "Interview rescheduled. It is now shown on the selected future date." });
    }

    const update = await database.from("leads").update({
      status,
      final_status: finalStatus,
      final_remarks: note || null,
      ...(interviewAt ? { follow_up_at: interviewAt } : {}),
      last_updated_by: authorization.userId,
      updated_at: updateAt
    }).eq("company_id", companyId).eq("id", lead.id);
    if (update.error) throw new Error(update.error.message);

    const event = await database.from("recruitment_lead_history").insert({
      company_id: companyId,
      lead_id: lead.id,
      event_type: "interview_outcome",
      field_name: "status",
      old_value: lead.status,
      new_value: status,
      remarks: note || null,
      actor_profile_id: authorization.userId,
      metadata: {
        outcome: eventCode,
        note: note || null,
        previous_interview_at: lead.follow_up_at,
        rescheduled_for: interviewAt,
        source_portal: "ops_pulse",
        station_updated: true
      }
    });
    if (event.error) throw new Error(event.error.message);

    revalidatePath("/work-force-register");
    revalidatePath("/leads/interviews");
  } catch (error) {
    if (isRedirect(error)) throw error;
    redirectTo = destination({
      tab: "interviews",
      date: value(formData, "queue_date") || null,
      error: error instanceof Error ? error.message : "Unable to update the interview."
    });
  }

  redirect(redirectTo);
}
