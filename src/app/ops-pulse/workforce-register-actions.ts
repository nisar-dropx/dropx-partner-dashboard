"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type InterviewOutcome = "reported" | "not_interested" | "rescheduled";

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

  const leadResult = await supabaseAdmin.from("leads")
    .select("id, station_code, status, interview_at")
    .eq("company_id", companyId)
    .eq("id", leadId)
    .is("archived_at", null)
    .maybeSingle();
  if (leadResult.error) throw new Error(leadResult.error.message);
  if (!leadResult.data) throw new Error("Recruit candidate was not found.");

  if (!authorization.hasAllLocationAccess) {
    const stationResult = await supabaseAdmin.from("stations")
      .select("id")
      .eq("company_id", companyId)
      .ilike("station_code", String(leadResult.data.station_code ?? ""))
      .limit(1)
      .maybeSingle();
    if (stationResult.error) throw new Error(stationResult.error.message);
    if (!stationResult.data || !authorization.locationScopeIds.includes(stationResult.data.id)) {
      throw new Error("This candidate is outside your station scope.");
    }
  }

  return { authorization, companyId, lead: leadResult.data };
}

export async function updateRecruitInterviewOutcome(formData: FormData) {
  const leadId = value(formData, "lead_id");
  const outcome = value(formData, "outcome") as InterviewOutcome;
  const note = value(formData, "note");
  const requestedDate = value(formData, "rescheduled_for");
  let redirectTo = destination({ tab: "interviews", date: value(formData, "queue_date") || null });

  try {
    if (!leadId) throw new Error("Choose a candidate.");
    if (!["reported", "not_interested", "rescheduled"].includes(outcome)) throw new Error("Choose a valid interview update.");

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
      status = "interview_reported";
      finalStatus = "Reported";
      eventCode = "interview_reported";
      redirectTo = destination({ tab: "dropx-id", candidate: leadId, notice: "Candidate reported. Send the DropX ID invitation to start registration." });
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
      ...(interviewAt ? { interview_at: interviewAt } : {}),
      last_status_at: updateAt,
      last_updated_by: authorization.userId,
      updated_at: updateAt
    }).eq("company_id", companyId).eq("id", lead.id);
    if (update.error) throw new Error(update.error.message);

    const event = await database.from("workforce_recruitment_events").insert({
      company_id: companyId,
      lead_id: lead.id,
      event_code: eventCode,
      event_at: updateAt,
      actor_user_id: authorization.userId,
      metadata: {
        note: note || null,
        previous_interview_at: lead.interview_at,
        rescheduled_for: interviewAt
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
