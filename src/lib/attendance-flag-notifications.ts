import "server-only";

import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

function peopleIntegrityReviewUrl() {
  // Managers review flags on the People surface, not dashboard.dropxlogistics.com.
  const people = process.env.PEOPLE_APP_URL?.replace(/\/$/, "");
  if (people) return `${people}/attendance/integrity`;
  return "https://people.dropxlogistics.com/attendance/integrity";
}

/** Resolve reporting manager + HR recipients for an attendance integrity flag. */
export async function notifyAttendanceFlagReviewers({
  companyId,
  profileType,
  profileId,
  employeeName,
  punchDate,
  flagType,
  message,
  flagId
}: {
  companyId: string;
  profileType?: string | null;
  profileId?: string | null;
  employeeName?: string | null;
  punchDate: string;
  flagType: string;
  message: string;
  flagId: string;
}) {
  if (!supabaseAdmin) return;

  let managerEmail: string | null = null;
  let managerUserId: string | null = null;
  let workerName = employeeName?.trim() || "Team member";
  let workerCode = "";

  if (profileId && profileType === "employee") {
    const employee = await supabaseAdmin
      .from("employees")
      .select("full_name, employee_code")
      .eq("company_id", companyId)
      .eq("id", profileId)
      .maybeSingle();
    if (!employee.error && employee.data) {
      workerName = String(employee.data.full_name || workerName);
      workerCode = String(employee.data.employee_code || "");
    }
    if (workerCode) {
      const linked = await supabaseAdmin
        .from("profiles")
        .select("id, reports_to_user_id")
        .eq("company_id", companyId)
        .eq("employee_id", workerCode)
        .maybeSingle();
      const reportsTo = linked.data?.reports_to_user_id as string | null | undefined;
      if (reportsTo) {
        const manager = await supabaseAdmin
          .from("profiles")
          .select("id, email, full_name")
          .eq("company_id", companyId)
          .eq("id", reportsTo)
          .eq("is_active", true)
          .maybeSingle();
        if (!manager.error && manager.data?.email) {
          managerEmail = String(manager.data.email);
          managerUserId = String(manager.data.id);
        }
      }
    }
  }

  if (profileId && profileType === "field_executive" && !managerEmail) {
    const executive = await supabaseAdmin
      .from("field_executives")
      .select("full_name, dropx_id")
      .eq("company_id", companyId)
      .eq("id", profileId)
      .maybeSingle();
    if (!executive.error && executive.data) {
      workerName = String(executive.data.full_name || workerName);
      workerCode = String(executive.data.dropx_id || "");
    }
  }

  const reviewUrl = `${peopleIntegrityReviewUrl()}?tab=flags&flagId=${encodeURIComponent(flagId)}`;
  const subject = `Attendance location flag · ${workerName}`;
  const body = [
    `${workerName}${workerCode ? ` (${workerCode})` : ""} has an attendance location flag.`,
    "",
    `Date: ${punchDate.split("-").reverse().join("/")}`,
    `Type: ${flagType.replaceAll("_", " ")}`,
    `Details: ${message}`,
    "",
    `Open on People to check device location, distance from station, and why they were flagged:`,
    reviewUrl,
    "",
    "Please review and follow up."
  ].join("\n");

  const recipients = new Set<string>();
  if (managerEmail) recipients.add(managerEmail.toLowerCase());

  // Also notify HRMS admins linked in People access when present.
  const hrAccess = await supabaseAdmin
    .from("hr_user_access")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("role_code", ["HRMS_ADMIN", "HR_MANAGER"]);
  if (!hrAccess.error && hrAccess.data?.length) {
    const hrProfiles = await supabaseAdmin
      .from("profiles")
      .select("email")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in(
        "id",
        hrAccess.data.map((row) => row.user_id)
      );
    for (const row of hrProfiles.data ?? []) {
      if (row.email) recipients.add(String(row.email).toLowerCase());
    }
  }

  if (!recipients.size) return { managerUserId, emailed: 0 };

  try {
    await sendEmail({
      companyId,
      to: Array.from(recipients),
      subject,
      body
    });
  } catch (error) {
    console.error("Unable to email attendance flag reviewers:", error);
  }

  return { managerUserId, emailed: recipients.size };
}
