import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// hr_company_settings.location_sample_retention_days (dropx-hrms migration
// 20260915120000_location_sample_retention_days.sql) lets a company override this per company
// — null falls back to this default. No settings-page field writes that column yet; add one
// in dropx-hrms's settings UI to make it actually configurable end-to-end.
const DEFAULT_RETENTION_DAYS = 60;
const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_COMPANY = 10;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role key is not configured." },
      { status: 500 }
    );
  }

  const companies = await supabaseAdmin
    .from("companies")
    .select("id, hr_company_settings(location_sample_retention_days)")
    .eq("is_active", true);
  if (companies.error) {
    // hr_company_settings might not exist as a joinable relation on a fresh install; fall
    // back to a single global cutoff rather than failing the whole cron.
    return runGlobalCleanup();
  }

  let totalDeleted = 0;
  const perCompany: Record<string, number> = {};

  for (const row of companies.data ?? []) {
    const companyId = row.id as string;
    const settings = Array.isArray(row.hr_company_settings)
      ? row.hr_company_settings[0]
      : row.hr_company_settings;
    const retentionDays =
      Number(settings?.location_sample_retention_days) > 0
        ? Number(settings?.location_sample_retention_days)
        : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    let deletedForCompany = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_COMPANY; batch += 1) {
      const selection = await supabaseAdmin
        .from("attendance_location_samples")
        .select("id")
        .eq("company_id", companyId)
        .lt("server_received_at", cutoff)
        .order("server_received_at", { ascending: true })
        .limit(BATCH_SIZE);

      if (selection.error) {
        if (String(selection.error.message).toLowerCase().includes("does not exist")) {
          return NextResponse.json({ skipped: true, reason: "table_not_present" });
        }
        return NextResponse.json({ error: selection.error.message }, { status: 500 });
      }

      const ids = (selection.data ?? []).map((item) => item.id as string);
      if (!ids.length) break;

      const removal = await supabaseAdmin
        .from("attendance_location_samples")
        .delete()
        .in("id", ids);
      if (removal.error) {
        return NextResponse.json({ error: removal.error.message }, { status: 500 });
      }

      deletedForCompany += ids.length;
      if (ids.length < BATCH_SIZE) break;
    }

    if (deletedForCompany > 0) {
      perCompany[companyId] = deletedForCompany;
      totalDeleted += deletedForCompany;
    }
  }

  return NextResponse.json({
    deleted: totalDeleted,
    per_company: perCompany,
    default_retention_days: DEFAULT_RETENTION_DAYS
  });
}

/** Fallback when the companies↔hr_company_settings join isn't available for any reason. */
async function runGlobalCleanup() {
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role key is not configured." },
      { status: 500 }
    );
  }
  const cutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deleted = 0;

  for (let batch = 0; batch < MAX_BATCHES_PER_COMPANY * 5; batch += 1) {
    const selection = await supabaseAdmin
      .from("attendance_location_samples")
      .select("id")
      .lt("server_received_at", cutoff)
      .order("server_received_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (selection.error) {
      if (String(selection.error.message).toLowerCase().includes("does not exist")) {
        return NextResponse.json({ skipped: true, reason: "table_not_present" });
      }
      return NextResponse.json({ error: selection.error.message }, { status: 500 });
    }
    const ids = (selection.data ?? []).map((row) => row.id as string);
    if (!ids.length) break;
    const removal = await supabaseAdmin.from("attendance_location_samples").delete().in("id", ids);
    if (removal.error) {
      return NextResponse.json({ error: removal.error.message }, { status: 500 });
    }
    deleted += ids.length;
    if (ids.length < BATCH_SIZE) break;
  }

  return NextResponse.json({ deleted, mode: "global_fallback", retention_days: DEFAULT_RETENTION_DAYS });
}
