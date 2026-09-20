import { NextResponse } from "next/server";
import { createAppNotification } from "@/lib/app-notifications";
import { loadAttendanceReportRows } from "@/lib/biometric/attendance";
import { isAttendanceReviewDue } from "@/lib/attendance-review-timing";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isWorkforceProfileType } from "@/lib/workforce-profiles";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DailyRow = {
  company_id: string;
  enrolment_id: string;
  in_time: string;
  out_time: string | null;
  punch_count: number | null;
  punch_date: string;
};

type EnrolmentRow = {
  account_id: string | null;
  employee_id: string | null;
  enrolment_id: string;
  field_executive_id: string | null;
  profile_type: string | null;
};

function isoDateInKolkata(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function previousIsoDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function enrolmentKey(value: string) {
  const clean = value.trim();
  const numeric = Number(clean);
  return Number.isFinite(numeric) ? String(numeric) : clean;
}

function profileAccount(row: EnrolmentRow) {
  return row.account_id || row.employee_id || row.field_executive_id;
}

function displayDate(value: string) {
  return value.split("-").reverse().join("/");
}

async function processCompany(companyId: string, fromDate: string, toDate: string, now: Date) {
  if (!supabaseAdmin) return { notified: 0, open: 0, skipped: 0 };
  const dailyResult = await supabaseAdmin
    .from("attendance_daily")
    .select("company_id, enrolment_id, in_time, out_time, punch_count, punch_date")
    .eq("company_id", companyId)
    .gte("punch_date", fromDate)
    .lte("punch_date", toDate)
    .not("in_time", "is", null)
    .is("out_time", null)
    .limit(1000);
  if (dailyResult.error) throw new Error(dailyResult.error.message);

  const openRows = (dailyResult.data ?? []) as DailyRow[];
  if (!openRows.length) return { notified: 0, open: 0, skipped: 0 };

  const enrolmentIds = Array.from(new Set(openRows.map((row) => row.enrolment_id)));
  const [enrolmentsResult, reportRows] = await Promise.all([
    supabaseAdmin
      .from("biometric_enrolments")
      .select("enrolment_id, profile_type, account_id, employee_id, field_executive_id")
      .eq("company_id", companyId)
      .eq("status", "Active")
      .is("effective_to", null)
      .in("enrolment_id", enrolmentIds),
    loadAttendanceReportRows({
      companyId,
      enrolmentIds,
      fromDate,
      reportType: "performance",
      toDate
    })
  ]);
  if (enrolmentsResult.error) throw new Error(enrolmentsResult.error.message);

  const enrolments = new Map<string, EnrolmentRow>();
  for (const row of (enrolmentsResult.data ?? []) as EnrolmentRow[]) {
    enrolments.set(enrolmentKey(row.enrolment_id), row);
  }
  const reportByDay = new Map(
    reportRows.map((row) => [`${enrolmentKey(row.enrolmentId)}:${row.punchDate}`, row])
  );

  let notified = 0;
  let skipped = 0;
  for (const daily of openRows) {
    const key = enrolmentKey(daily.enrolment_id);
    const enrolment = enrolments.get(key);
    const report = reportByDay.get(`${key}:${daily.punch_date}`);
    const profileType = String(enrolment?.profile_type ?? "");
    const accountId = enrolment ? profileAccount(enrolment) : null;
    if (!report || !accountId || !isWorkforceProfileType(profileType)) {
      skipped += 1;
      continue;
    }
    if (!isAttendanceReviewDue({
      punchDate: daily.punch_date,
      scheduledEnd: report.scheduledEnd,
      scheduledStart: report.scheduledStart
    }, now)) {
      skipped += 1;
      continue;
    }

    const created = await createAppNotification({
      accountId,
      companyId,
      data: {
        attendanceStatus: report.attendanceStatus,
        enrolmentId: daily.enrolment_id,
        inTime: daily.in_time,
        punchDate: daily.punch_date,
        scheduledEnd: report.scheduledEnd,
        scheduledStart: report.scheduledStart
      },
      eventCode: "attendance_exception_review",
      profileType,
      sourceKey: `attendance-review:${daily.enrolment_id}:${daily.punch_date}`,
      variables: { date: displayDate(daily.punch_date) }
    });
    if (created) notified += 1;
    else skipped += 1;
  }
  return { notified, open: openRows.length, skipped };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });
  }

  try {
    const now = new Date();
    const toDate = isoDateInKolkata(now);
    const fromDate = previousIsoDate(toDate);
    const companies = await supabaseAdmin.from("companies").select("id").eq("is_active", true);
    if (companies.error) throw new Error(companies.error.message);

    const totals = { notified: 0, open: 0, skipped: 0 };
    for (const company of companies.data ?? []) {
      const result = await processCompany(String(company.id), fromDate, toDate, now);
      totals.notified += result.notified;
      totals.open += result.open;
      totals.skipped += result.skipped;
    }
    return NextResponse.json({ fromDate, toDate, ...totals });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to process attendance reminders."
    }, { status: 500 });
  }
}
