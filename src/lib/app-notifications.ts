import "server-only";

import { formatDuration, formatTime } from "@/lib/biometric/attendance";
import { deliverNotificationPush } from "@/lib/firebase-push";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType } from "@/lib/workforce-profiles";

export const attendanceNotificationEvents = ["attendance_punch_in", "attendance_punch_out"] as const;
export type AttendanceNotificationEvent = typeof attendanceNotificationEvents[number];

export const appNotificationEvents = [
  ...attendanceNotificationEvents,
  "profile_submitted",
  "profile_approved",
  "profile_returned",
  "attendance_regularization_submitted",
  "attendance_location_flagged",
  "attendance_forgot_punch_out",
  "advance_request_raised",
  "advance_request_approved",
  "advance_request_rejected",
  "exit_request_raised",
  "exit_request_approved",
  "exit_request_rejected"
] as const;
export type AppNotificationEvent = typeof appNotificationEvents[number];

export const appNotificationDefaults: Record<AppNotificationEvent, {
  bodyTemplate: string;
  label: string;
  route: "advances" | "attendance" | "profile";
  titleTemplate: string;
}> = {
  attendance_punch_in: {
    label: "Punch",
    route: "attendance",
    titleTemplate: "Punch Captured",
    bodyTemplate: "Your punch was captured at {time} on {date}."
  },
  attendance_punch_out: {
    label: "Punch",
    route: "attendance",
    titleTemplate: "Punch Captured",
    bodyTemplate: "Your punch was captured at {time} on {date}."
  },
  profile_submitted: {
    label: "Profile submitted",
    route: "profile",
    titleTemplate: "Profile submitted",
    bodyTemplate: "Your profile has been submitted successfully."
  },
  profile_approved: {
    label: "Profile approved",
    route: "profile",
    titleTemplate: "Profile approved",
    bodyTemplate: "Your profile has been approved and activated."
  },
  profile_returned: {
    label: "Profile returned",
    route: "profile",
    titleTemplate: "Profile returned",
    bodyTemplate: "Your profile has been returned for correction. {remarks}"
  },
  attendance_regularization_submitted: {
    label: "Regularization submitted",
    route: "attendance",
    titleTemplate: "Regularization submitted",
    bodyTemplate: "Your attendance regularization request for {date} has been submitted."
  },
  attendance_location_flagged: {
    label: "Location flagged",
    route: "attendance",
    titleTemplate: "Attendance flagged for review",
    bodyTemplate: "Your attendance for {date} was flagged. Attach a selfie + location support package."
  },
  attendance_forgot_punch_out: {
    label: "Forgot punch-out",
    route: "attendance",
    titleTemplate: "Punch-out reminder",
    bodyTemplate: "You have been punched in for {hours} hours on {date}. Please punch out."
  },
  advance_request_raised: {
    label: "Advance request raised",
    route: "advances",
    titleTemplate: "Advance request raised",
    bodyTemplate: "Your advance request for Rs {amount} has been submitted for approval."
  },
  advance_request_approved: {
    label: "Advance request approved",
    route: "advances",
    titleTemplate: "Advance request approved",
    bodyTemplate: "Your advance request has been approved for Rs {amount}."
  },
  advance_request_rejected: {
    label: "Advance request rejected",
    route: "advances",
    titleTemplate: "Advance request rejected",
    bodyTemplate: "Your advance request was rejected. {remarks}"
  },
  exit_request_raised: {
    label: "Exit request raised",
    route: "profile",
    titleTemplate: "Exit request raised",
    bodyTemplate: "Your exit request has been submitted for review."
  },
  exit_request_approved: {
    label: "Exit request approved",
    route: "profile",
    titleTemplate: "Exit request approved",
    bodyTemplate: "Your exit request has been approved. {remarks}"
  },
  exit_request_rejected: {
    label: "Exit request rejected",
    route: "profile",
    titleTemplate: "Exit request rejected",
    bodyTemplate: "Your exit request was rejected. {remarks}"
  }
};

export const attendanceNotificationDefaults = {
  attendance_punch_in: appNotificationDefaults.attendance_punch_in,
  attendance_punch_out: appNotificationDefaults.attendance_punch_out
};

function isMissingNotificationSchema(error: { code?: string; message?: string } | null | undefined) {
  const message = error?.message?.toLowerCase() ?? "";
  return error?.code === "42P01" ||
    message.includes("mob_app_notification") ||
    message.includes("schema cache") ||
    message.includes("does not exist");
}

function formatPunchDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function applyVariables(template: string, variables: Record<string, string>) {
  return Object.entries(variables).reduce(
    (message, [key, value]) => message.replaceAll(`{${key}}`, value),
    template
  );
}

export async function createAppNotification({
  accountId,
  companyId,
  data = {},
  eventCode,
  profileType,
  sourceKey,
  variables = {}
}: {
  accountId: string;
  companyId: string;
  data?: Record<string, unknown>;
  eventCode: AppNotificationEvent;
  profileType: string;
  sourceKey: string;
  variables?: Record<string, string>;
}) {
  if (!supabaseAdmin || !isWorkforceProfileType(profileType)) return;

  const defaults = appNotificationDefaults[eventCode];
  const ruleResult = await supabaseAdmin
    .from("mob_app_notification_rules")
    .select("enabled, title_template, body_template, route")
    .eq("company_id", companyId)
    .eq("event_code", eventCode)
    .maybeSingle();

  if (ruleResult.error && !isMissingNotificationSchema(ruleResult.error)) {
    console.error("Unable to load app notification rule:", ruleResult.error.message);
  }
  if (ruleResult.data?.enabled === false) return;

  const title = applyVariables(
    String(ruleResult.data?.title_template ?? defaults.titleTemplate),
    variables
  );
  const body = applyVariables(
    String(ruleResult.data?.body_template ?? defaults.bodyTemplate),
    variables
  ).replace(/\s+/g, " ").trim();
  const notificationResult = await supabaseAdmin
    .from("mob_app_notifications")
    .upsert({
      body,
      company_id: companyId,
      data,
      event_code: eventCode,
      push_status: "not_configured",
      recipient_account_id: accountId,
      recipient_profile_type: profileType,
      route: String(ruleResult.data?.route ?? defaults.route),
      source_key: sourceKey,
      title
    }, {
      ignoreDuplicates: true,
      onConflict: "company_id,event_code,source_key,recipient_account_id"
    })
    .select("id");

  if (notificationResult.error && !isMissingNotificationSchema(notificationResult.error)) {
    console.error("Unable to create app notification:", notificationResult.error.message);
  }
  const notificationId = notificationResult.data?.[0]?.id;
  if (notificationId) {
    await deliverNotificationPush({
      id: notificationId,
      companyId,
      profileType,
      accountId,
      title,
      body,
      route: String(ruleResult.data?.route ?? defaults.route),
      data
    });
  }
}

export async function createAttendancePunchNotification({
  accountId,
  companyId,
  firstPunchTime,
  profileType,
  punchDate,
  punchId,
  punchOrder,
  punchTime
}: {
  accountId: string;
  companyId: string;
  firstPunchTime: Date;
  profileType: string;
  punchDate: string;
  punchId: string;
  punchOrder: number;
  punchTime: Date;
}) {
  if (!supabaseAdmin || !isWorkforceProfileType(profileType)) return;

  const eventCode: AttendanceNotificationEvent =
    punchOrder === 1 ? "attendance_punch_in" : "attendance_punch_out";
  const defaults = attendanceNotificationDefaults[eventCode];
  const ruleResult = await supabaseAdmin
    .from("mob_app_notification_rules")
    .select("enabled")
    .eq("company_id", companyId)
    .eq("event_code", eventCode)
    .maybeSingle();

  if (ruleResult.error && !isMissingNotificationSchema(ruleResult.error)) {
    console.error("Unable to load app notification rule:", ruleResult.error.message);
  }
  if (ruleResult.data?.enabled === false) return;

  const workMinutes = punchOrder > 1
    ? Math.max(0, Math.round((punchTime.getTime() - firstPunchTime.getTime()) / 60000))
    : 0;
  const variables = {
    date: formatPunchDate(punchDate),
    punch_count: String(punchOrder),
    time: formatTime(punchTime),
    work_duration: formatDuration(workMinutes)
  };
  const title = applyVariables(defaults.titleTemplate, variables);
  const body = applyVariables(defaults.bodyTemplate, variables);

  const notificationData = {
    punchDate,
    punchId,
    punchOrder,
    punchTime: punchTime.toISOString(),
    punchType: punchOrder === 1 ? "in" : "out",
    workDuration: variables.work_duration
  };
  const notificationResult = await supabaseAdmin
    .from("mob_app_notifications")
    .upsert({
      body,
      company_id: companyId,
      data: notificationData,
      event_code: eventCode,
      push_status: "not_configured",
      recipient_account_id: accountId,
      recipient_profile_type: profileType,
      route: "attendance",
      source_key: punchId,
      title
    }, {
      ignoreDuplicates: true,
      onConflict: "company_id,event_code,source_key,recipient_account_id"
    })
    .select("id");

  if (notificationResult.error && !isMissingNotificationSchema(notificationResult.error)) {
    console.error("Unable to create attendance notification:", notificationResult.error.message);
  }
  const notificationId = notificationResult.data?.[0]?.id;
  if (notificationId) {
    await deliverNotificationPush({
      id: notificationId,
      companyId,
      profileType,
      accountId,
      title,
      body,
      route: "attendance",
      data: notificationData
    });
  }
}
