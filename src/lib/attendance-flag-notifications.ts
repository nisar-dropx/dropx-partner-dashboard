import "server-only";

import { supabaseAdmin } from "@/lib/supabase-admin";

function peopleIntegrityHref(flagId: string) {
  return `/attendance/integrity?tab=flags&flagId=${encodeURIComponent(flagId)}`;
}

/** Create in-app People web notifications for managers/HR — no email. */
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
  if (!supabaseAdmin) return { notified: 0 };

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
      if (reportsTo) managerUserId = reportsTo;
    }
  }

  if (profileId && profileType === "field_executive") {
    const executive = await supabaseAdmin
      .from("workforce")
      .select("full_name, dropx_id")
      .eq("company_id", companyId)
      .eq("id", profileId)
      .maybeSingle();
    if (!executive.error && executive.data) {
      workerName = String(executive.data.full_name || workerName);
      workerCode = String(executive.data.dropx_id || "");
    }
  }

  const recipientIds = new Set<string>();
  if (managerUserId) recipientIds.add(managerUserId);

  const hrNotifyRoles = new Set([
    "OWNER",
    "OWNER_BREAK_GLASS",
    "HR_HEAD",
    "HR_OPERATIONS",
    "HR_EXECUTIVE",
    "HRMS_ADMIN",
    "HR_MANAGER"
  ]);
  const roleUsers = await supabaseAdmin
    .from("hr_user_access")
    .select("user_id, hr_roles!inner(code)")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (!roleUsers.error) {
    for (const row of roleUsers.data ?? []) {
      const nested = (row as { hr_roles?: { code?: string } | Array<{ code?: string }> }).hr_roles;
      const roleCode = Array.isArray(nested)
        ? String(nested[0]?.code || "")
        : String(nested?.code || "");
      if (hrNotifyRoles.has(roleCode) && row.user_id) {
        recipientIds.add(String(row.user_id));
      }
    }
  } else {
    console.error("Unable to load HR recipients for People notifications:", roleUsers.error.message);
  }

  if (!recipientIds.size) return { notified: 0, managerUserId };

  const title = `Location flag · ${workerName}`;
  const body = [
    `${workerName}${workerCode ? ` (${workerCode})` : ""}`,
    message,
    `Date ${punchDate.split("-").reverse().join("/")} · ${flagType.replaceAll("_", " ")}`
  ].join(" · ");
  const href = peopleIntegrityHref(flagId);
  const sourceKey = `attendance-flag:${flagId}`;
  const rows = Array.from(recipientIds).map((recipientUserId) => ({
    company_id: companyId,
    recipient_user_id: recipientUserId,
    event_code: "attendance_location_flagged",
    title: title.slice(0, 160),
    body: body.slice(0, 480),
    href,
    source_key: sourceKey,
    data: {
      flagId,
      profileId,
      profileType,
      punchDate,
      flagType,
      message
    }
  }));

  const insert = await supabaseAdmin.from("people_web_notifications").upsert(rows, {
    ignoreDuplicates: true,
    onConflict: "company_id,event_code,source_key,recipient_user_id"
  });
  if (insert.error) {
    if (/does not exist|schema cache/i.test(insert.error.message)) {
      console.error("people_web_notifications missing — run people_web_notifications_v1.sql / HRMS migration.");
      return { notified: 0, managerUserId };
    }
    console.error("Unable to create People web notifications:", insert.error.message);
    return { notified: 0, managerUserId };
  }

  return { notified: rows.length, managerUserId };
}
