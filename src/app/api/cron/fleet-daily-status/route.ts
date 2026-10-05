import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { loadAdHocActivity, isAdHocActivityLocation } from "@/lib/ops-pulse/adhoc-activity";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { fleetAdHocRequestType } from "@/lib/fleet-control-adhoc-scope";
import { buildFleetDailyStatusEmail, normalizeFleetDailyStatusEmailConfig, type FleetDailyStatusAdHocSummary, type FleetDailyStatusSummary as Summary, type FleetDailyStatusVehicle as Vehicle } from "@/lib/fleet/daily-status-email";
import { loadFleetDailyStatusRecipients, resolveFleetDailyStatusDeliveryRecipients } from "@/lib/fleet/daily-status-recipients";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const clean = (value: unknown) => String(value ?? "").trim();
const email = (value: unknown) => { const result = clean(value).toLowerCase(); return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result) ? result : null; };
const active = (status: unknown) => clean(status).toLowerCase() === "active";
const closed = (status: unknown) => ["sold", "disposed", "returned"].includes(clean(status).toLowerCase());
const own = (type: unknown) => clean(type).toLowerCase() === "own";
const approved = (status: unknown, source: string) => {
  const value = clean(status).toLowerCase();
  return source === "Cashbook" || ["approved", "final_approved", "re_approved", "processing", "processed", "paid"].includes(value) || value.endsWith("_approved");
};
const pending = (status: unknown, source: string) => source !== "Cashbook" && ["pending", "re_pending", "submitted", "resubmitted", "under_review", "awaiting_approval"].includes(clean(status).toLowerCase());
const isAmazonNow = (location: any) => (Array.isArray(location.location_models) ? location.location_models : [location.location_models]).some((model: any) => /(?:^|\s)(?:AMAZON\s+)?NOW(?:\s|$)/i.test(`${clean(model?.code)} ${clean(model?.name)}`));
const summaryTotals = (rows: Summary[]) => ({ totalVehicles: rows.reduce((sum, row) => sum + row.ownTotal + row.partnerTotal, 0), operational: rows.reduce((sum, row) => sum + row.ownOperational + row.partnerOperational, 0), nonOperational: rows.reduce((sum, row) => sum + row.totalNonOperational, 0), adHoc: 0, adHocPending: 0, stationCount: rows.length });

function kolkataParts() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

function inWindow(now: string, configured: string) {
  const minutes = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return hour * 60 + minute; };
  const delta = minutes(now) - minutes(configured || "20:00");
  return delta >= 0 && delta < 30;
}

async function processCompany(company: { id: string; name: string | null }, date: string, time: string, force = false) {
  if (!supabaseAdmin) return "failed";
  const database = supabaseAdmin;
  const setting = await supabaseAdmin.from("fleet_control_settings").select("daily_status_email_enabled,daily_status_send_time,daily_status_only_affected,daily_status_email_config").eq("company_id", company.id).eq("daily_status_email_enabled", true).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (setting.error || !setting.data?.daily_status_email_enabled || (!force && !inWindow(time, clean(setting.data.daily_status_send_time)))) return "disabled";
  const config = normalizeFleetDailyStatusEmailConfig(setting.data.daily_status_email_config);
  const locationsResult = await loadCodLocations(company.id, [], true);
  const excludedCodes = new Set(config.excludedStationCodes);
  const amazonNowCodes = new Set(locationsResult.locations.filter(isAmazonNow).map((location) => clean(location.station_code).toUpperCase()).filter(Boolean));
  const reportLocations = locationsResult.locations.filter((location) => { const code = clean(location.station_code).toUpperCase(); return !excludedCodes.has(code) && !(config.excludeAmazonNow && amazonNowCodes.has(code)); });
  const activity = await loadAdHocActivity(company.id, reportLocations.filter(isAdHocActivityLocation), `${date.slice(0, 7)}-01`, date);
  const [vehiclesResult, recipientsResult] = await Promise.all([
    supabaseAdmin.from("fleet_vehicles").select("vehicle_no,station_code,model,ownership_type,status,non_operational_since,expected_operational_date,status_comment,status_reason_key").eq("company_id", company.id),
    supabaseAdmin.from("fleet_status_report_recipients").select("name,email,station_codes").eq("company_id", company.id).eq("is_active", true)
  ]);
  if (vehiclesResult.error || recipientsResult.error || activity.error) throw new Error(vehiclesResult.error?.message || recipientsResult.error?.message || activity.error || "Fleet data could not be loaded.");
  const vehicles = ((vehiclesResult.data ?? []) as Vehicle[]).filter((row) => { const code = clean(row.station_code).toUpperCase(); return !closed(row.status) && !excludedCodes.has(code) && !(config.excludeAmazonNow && amazonNowCodes.has(code)); });
  const typedActivity = activity.stations.flatMap((station) => station.days.flatMap((day) => day.entries.flatMap((entry) => { const type = fleetAdHocRequestType(entry); return type ? [{ station: clean(station.code).toUpperCase(), date: day.date, type, amount: Number(entry.amount) || 0, approvalStatus: entry.approvalStatus, source: entry.source }] : []; })));
  const approvedActivity = typedActivity.filter((row) => approved(row.approvalStatus, row.source));
  const pendingActivity = typedActivity.filter((row) => pending(row.approvalStatus, row.source));
  const todayActivity = approvedActivity.filter((row) => row.date === date); const todayPendingActivity = pendingActivity.filter((row) => row.date === date);
  const approvedVans = todayActivity.filter((row) => row.type === "Van");
  const todayAdHocStations = new Set([...todayActivity, ...todayPendingActivity].map((row) => row.station));
  const adHocKeys = [...new Set([...approvedActivity, ...pendingActivity].filter((row) => todayAdHocStations.has(row.station)).map((row) => `${row.station}|${row.type}`))];
  const adHocRows: FleetDailyStatusAdHocSummary[] = adHocKeys.map((key) => {
    const [station, typeValue] = key.split("|"); const type = typeValue as "Van" | "Driver";
    const todayRows = todayActivity.filter((row) => row.station === station && row.type === type); const todayPendingRows = todayPendingActivity.filter((row) => row.station === station && row.type === type);
    const pendingRows = pendingActivity.filter((row) => row.station === station && row.type === type); const mtdRows = approvedActivity.filter((row) => row.station === station && row.type === type);
    return { station, type, todayCount: todayRows.length, todayAmount: todayRows.reduce((sum, row) => sum + row.amount, 0), todayPendingCount: todayPendingRows.length, todayPendingAmount: todayPendingRows.reduce((sum, row) => sum + row.amount, 0), pendingCount: pendingRows.length, pendingAmount: pendingRows.reduce((sum, row) => sum + row.amount, 0), mtdCount: mtdRows.length, mtdAmount: mtdRows.reduce((sum, row) => sum + row.amount, 0) };
  });
  const todayAdHocByStation = new Map<string, number>(); for (const row of adHocRows) todayAdHocByStation.set(row.station, (todayAdHocByStation.get(row.station) || 0) + row.todayCount + row.todayPendingCount);
  const codes = [...new Set([...vehicles.map((row) => clean(row.station_code).toUpperCase()), ...todayActivity.map((row) => row.station), ...todayPendingActivity.map((row) => row.station)].filter(Boolean))].sort();
  const allRows = codes.map((station): Summary => {
    const stationVehicles = vehicles.filter((row) => clean(row.station_code).toUpperCase() === station); const owned = stationVehicles.filter((row) => own(row.ownership_type)); const partner = stationVehicles.filter((row) => !own(row.ownership_type));
    const ownOperational = owned.filter((row) => active(row.status)).length; const partnerOperational = partner.filter((row) => active(row.status)).length;
    return { station, ownTotal: owned.length, ownOperational, ownNonOperational: owned.length - ownOperational, partnerTotal: partner.length, partnerOperational, partnerNonOperational: partner.length - partnerOperational, totalNonOperational: stationVehicles.filter((row) => !active(row.status)).length, adHocVans: approvedVans.filter((row) => row.station === station).length };
  });
  const rows = allRows.sort((left, right) => right.totalNonOperational - left.totalNonOperational || right.adHocVans - left.adHocVans || left.station.localeCompare(right.station));
  const attentionRows = rows.filter((row) => row.totalNonOperational > 0 || (config.includeAdHoc && (todayAdHocByStation.get(row.station) || 0) > 0));
  if (setting.data.daily_status_only_affected !== false && !attentionRows.length) return "no_affected_station";
  if (!rows.length) return "no_fleet_data";

  const triggerStationCodes = (setting.data.daily_status_only_affected === false ? rows : attentionRows).map((row) => row.station);
  const automatic = await loadFleetDailyStatusRecipients(supabaseAdmin, company.id, reportLocations, config);
  const manual = (recipientsResult.data ?? []).map((row) => ({ name: clean(row.name), email: email(row.email), stationCodes: Array.isArray(row.station_codes) ? row.station_codes.map((value: string) => clean(value).toUpperCase()).filter(Boolean) : [] }));
  const scopedRecipients = resolveFleetDailyStatusDeliveryRecipients(automatic, manual, rows.map((row) => row.station), triggerStationCodes, setting.data.daily_status_only_affected !== false);
  // Intersect the recipient's existing station scope with each Location Master region.
  const regionByStation = new Map(reportLocations.map(location => [clean(location.station_code).toUpperCase(), clean(location.region) || "Unassigned region"]));
  const deliveries = scopedRecipients.flatMap(recipient => {
    const groups = new Map<string, string[]>();
    for (const station of recipient.stationCodes) {
      const region = regionByStation.get(station) || "Unassigned region";
      groups.set(region, [...(groups.get(region) || []), station]);
    }
    return [...groups].map(([region, stationCodes]) => ({ ...recipient, region, stationCodes }));
  });
  if (!deliveries.length) throw new Error("No station-scoped Operations, Fleet, Business Head, station mailbox or manual recipient was found for the affected stations.");
  const existing = await supabaseAdmin.from("fleet_status_report_logs").select("recipient_email,region_key,status").eq("company_id", company.id).eq("report_date", date);
  if (existing.error) throw new Error(existing.error.message);
  const existingStatus = new Map((existing.data ?? []).map((row) => [`${clean(row.recipient_email).toLowerCase()}|${row.region_key}`, clean(row.status).toLowerCase()]));
  const month = date.slice(0, 7); const monthLabel = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${month}-01T12:00:00+05:30`));
  const dailyLabel = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${date}T12:00:00+05:30`));
  const deliveryResults = await Promise.all(deliveries.map(async (delivery) => {
    const deliveryEmail = clean(delivery.email).toLowerCase();
    const deliveryKey = `${deliveryEmail}|${delivery.region}`;
    if (["sent", "skipped"].includes(existingStatus.get(deliveryKey) || "")) return "skipped" as const;
    const stationScope = new Set(delivery.stationCodes); const scopedRows = rows.filter((row) => stationScope.has(row.station)); const scopedFleetRows = scopedRows.filter((row) => row.ownTotal + row.partnerTotal > 0);
    const scopedVehicles = vehicles.filter((row) => stationScope.has(clean(row.station_code).toUpperCase())); const scopedAdHocRows = adHocRows.filter((row) => stationScope.has(row.station)); const scopedAttention = attentionRows.filter((row) => stationScope.has(row.station));
    const totals = { ...summaryTotals(scopedFleetRows), adHoc: scopedAdHocRows.reduce((sum, row) => sum + row.todayCount, 0), adHocPending: scopedAdHocRows.reduce((sum, row) => sum + row.todayPendingCount, 0) };
    try {
      const claimPayload = { company_id: company.id, report_date: date, report_month: month, recipient_email: deliveryEmail, region_key: delivery.region, affected_station_codes: scopedAttention.map((row) => row.station), recipients: [deliveryEmail], subject: `${config.subjectPrefix} | ${delivery.region} | ${config.monthlyThread ? monthLabel : dailyLabel}`, status: "skipped", error_message: null };
      const claim = existingStatus.get(deliveryKey) === "failed"
        ? await database.from("fleet_status_report_logs").update(claimPayload).eq("company_id", company.id).eq("report_date", date).eq("recipient_email", deliveryEmail).eq("region_key", delivery.region).eq("status", "failed").select("id").maybeSingle()
        : await database.from("fleet_status_report_logs").upsert(claimPayload, { onConflict: "company_id,report_date,recipient_email,region_key", ignoreDuplicates: true }).select("id").maybeSingle();
      if (claim.error) throw new Error(claim.error.message);
      if (!claim.data) return "skipped" as const;
      const prior = config.monthlyThread ? await database.from("fleet_status_report_logs").select("message_id,root_message_id,subject").eq("company_id", company.id).eq("recipient_email", deliveryEmail).eq("region_key", delivery.region).eq("report_month", month).eq("status", "sent").order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null, error: null };
      if (prior.error) throw new Error(prior.error.message);
      const subject = prior.data?.subject || `${config.subjectPrefix} | ${delivery.region} | ${config.monthlyThread ? monthLabel : dailyLabel}`; const root = prior.data?.root_message_id || prior.data?.message_id || null; const last = prior.data?.message_id || null;
      const messageId = last ? `<dropx.fleet-status.${randomUUID()}@partner.dropxlogistics.com>` : `<dropx.fleet-status.${company.id}.${config.monthlyThread ? month : date}.${randomUUID()}@partner.dropxlogistics.com>`;
      const presentation = buildFleetDailyStatusEmail({ companyName: company.name, region: delivery.region, date, rows: scopedFleetRows, exceptions: scopedVehicles.filter((row) => own(row.ownership_type) && !active(row.status)), adHocRows: scopedAdHocRows, totals, config });
      const result = await sendEmail({ companyId: company.id, to: [deliveryEmail], subject, body: presentation.text, html: presentation.html, messageId, inReplyTo: last || undefined, references: last ? [...new Set([root, last].filter((value): value is string => Boolean(value)))] : undefined });
      const log = await database.from("fleet_status_report_logs").update({ affected_station_codes: scopedAttention.map((row) => row.station), recipients: [deliveryEmail], subject, status: "sent", message_id: result.messageId || messageId, root_message_id: root || result.messageId || messageId, error_message: null }).eq("company_id", company.id).eq("report_date", date).eq("recipient_email", deliveryEmail).eq("region_key", delivery.region).eq("status", "skipped");
      if (log.error) throw new Error(log.error.message); return "sent" as const;
    } catch (error) {
      await database.from("fleet_status_report_logs").update({ status: "failed", error_message: error instanceof Error ? error.message : "Unable to send report." }).eq("company_id", company.id).eq("report_date", date).eq("recipient_email", deliveryEmail).eq("region_key", delivery.region).eq("status", "skipped");
      return "failed" as const;
    }
  }));
  const sent = deliveryResults.filter((result) => result === "sent").length;
  const failed = deliveryResults.filter((result) => result === "failed").length;
  const skipped = deliveryResults.filter((result) => result === "skipped").length;
  if (failed && !sent) return "failed";
  if (failed) return "partial_failed";
  if (sent) return "sent";
  return skipped ? "already_sent" : "disabled";
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 500 });
  const params = new URL(request.url).searchParams;
  const force = params.get("force") === "1";
  const now = kolkataParts();
  const requestedDate = clean(params.get("date"));
  const date = force && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : now.date;
  const time = now.time;
  const requestedCompanyId = clean(params.get("company_id"));
  let settingsQuery = supabaseAdmin.from("fleet_control_settings").select("company_id").eq("daily_status_email_enabled", true);
  if (force && requestedCompanyId) settingsQuery = settingsQuery.eq("company_id", requestedCompanyId);
  const configured = await settingsQuery;
  if (configured.error) return NextResponse.json({ error: configured.error.message }, { status: 500 });
  const companyIds = [...new Set((configured.data ?? []).map((row) => clean(row.company_id)).filter(Boolean))];
  const companyNames = companyIds.length ? await supabaseAdmin.from("companies").select("id,name").in("id", companyIds) : { data: [], error: null };
  if (companyNames.error) return NextResponse.json({ error: companyNames.error.message }, { status: 500 });
  const namesById = new Map((companyNames.data ?? []).map((company) => [company.id, company.name]));
  const companies = companyIds.map((id) => ({ id, name: namesById.get(id) ?? "DropX" }));
  const totals: Record<string, number> = {};
  const details: Array<{ companyId: string; company: string | null; outcome: string }> = [];
  for (const company of companies) {
    try {
      const outcome = await processCompany(company, date, time, force);
      totals[outcome] = (totals[outcome] || 0) + 1;
      details.push({ companyId: company.id, company: company.name, outcome });
    } catch {
      totals.failed = (totals.failed || 0) + 1;
      details.push({ companyId: company.id, company: company.name, outcome: "failed" });
    }
  }
  return NextResponse.json({ date, time, forced: force, ...totals, details }, { status: totals.failed || totals.partial_failed ? 500 : 200 });
}
