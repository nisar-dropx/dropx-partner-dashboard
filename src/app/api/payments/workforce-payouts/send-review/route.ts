import { waitUntil } from "@vercel/functions";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { processPayoutReviewNotifications } from "@/lib/payout-review-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { processWorkforcePayoutAppNotifications } from "@/lib/workforce-payout-app-notifications";
import {
  workforcePayoutLocationSetHash,
  workforcePayoutPublicationSnapshotHash
} from "@/lib/workforce-payout-publication";
import type { WorkforcePayoutPublicationSnapshot } from "@/lib/workforce-payout-publication-snapshot";
import {
  chunkValues,
  MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION,
  MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES,
  serializedJsonByteLength,
  WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK
} from "@/lib/workforce-payout-publication-limits";
import { workforcePayoutReviewTokenDetails } from "@/lib/workforce-payout-review-token";
import {
  buildWorkforcePayoutTemplateComponents,
  normalizeWorkforceWhatsAppRecipient,
  workforcePayoutWhatsAppValues,
  WORKFORCE_PAYOUT_WHATSAPP_EVENT
} from "@/lib/workforce-payout-whatsapp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_WINDOW_DAYS = 7;
type PublicationSnapshot = WorkforcePayoutPublicationSnapshot;

function responseError(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function validDate(value: unknown) {
  const text = String(value ?? "");
  return DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));
}

function completeCalendarMonth(periodStart: string, periodEnd: string) {
  if (!validDate(periodStart) || !validDate(periodEnd) || !periodStart.endsWith("-01")) return false;
  const end = new Date(`${periodStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10) === periodEnd;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function verifiedPublicationSnapshot(value: unknown, expected: {
  dependencyHash: string;
  locationId: string;
  periodEnd: string;
  periodStart: string;
  snapshotHash: string;
  workforceId: string;
}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PublicationSnapshot>;
  if (snapshot.schema_version !== 2
    || snapshot.source !== "workforce_payout_worksheet"
    || snapshot.dependency_hash !== expected.dependencyHash
    || snapshot.run?.period_start !== expected.periodStart
    || snapshot.run?.period_end !== expected.periodEnd
    || snapshot.item?.workforce_id !== expected.workforceId
    || snapshot.item?.station_id !== expected.locationId
    || !Array.isArray(snapshot.lines)
    || !snapshot.worksheet
    || workforcePayoutPublicationSnapshotHash(snapshot as PublicationSnapshot) !== expected.snapshotHash) {
    return null;
  }
  return snapshot as PublicationSnapshot;
}

async function loadNotificationRecipients(companyId: string, workforceIds: string[]) {
  const recipients: Array<{
    id: string;
    full_name: string | null;
    dropx_id: string | null;
    mobile: string | null;
    mobile_country_code: string | null;
  }> = [];
  const uniqueIds = [...new Set(workforceIds)];
  for (const idChunk of chunkValues(uniqueIds, WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK)) {
    const page = await supabaseAdmin!
      .from("workforce")
      .select("id,full_name,dropx_id,mobile,mobile_country_code")
      .eq("company_id", companyId)
      .in("id", idChunk);
    if (page.error) return { data: recipients, error: page.error, expected: uniqueIds.length };
    recipients.push(...(page.data ?? []));
  }
  return { data: recipients, error: null, expected: uniqueIds.length };
}

async function notificationPreflight(
  companyId: string,
  snapshots: Array<{ workforceId: string; snapshot: PublicationSnapshot }>,
  reviewUntil: string
) {
  const config = await supabaseAdmin!
    .from("whatsapp_notification_configs")
    .select("id,app_notification_enabled,is_enabled,whatsapp_profile_id,template_id,template_name,template_language,variable_mappings,updated_at")
    .eq("company_id", companyId)
    .eq("event_code", WORKFORCE_PAYOUT_WHATSAPP_EVENT)
    .maybeSingle();
  if (config.error || !config.data) {
    throw new Error("Save the Workforce payout notification setting before publishing payouts.");
  }
  const whatsappNotificationEnabled = Boolean(config.data.is_enabled);
  const appNotificationEnabled = Boolean(config.data.app_notification_enabled);
  if (!whatsappNotificationEnabled && !appNotificationEnabled) {
    throw new Error("Enable App or WhatsApp notifications before publishing payouts.");
  }

  const people = await loadNotificationRecipients(companyId, snapshots.map((entry) => entry.workforceId));
  if (people.error || people.data.length !== people.expected) {
    throw new Error("One or more selected Workforce recipients are unavailable.");
  }

  const personById = new Map((people.data ?? []).map((person) => [String(person.id), person]));
  let activeProfile: { id: string } | null = null;
  let approvedTemplate: {
    template_id: string;
    name: string;
    language: string;
    components: unknown;
  } | null = null;
  let mappings: Record<string, string> = {};

  if (whatsappNotificationEnabled) {
    if (!config.data.whatsapp_profile_id || !config.data.template_id || !config.data.template_name || !config.data.template_language) {
      throw new Error("Select an approved WhatsApp template and sending profile before publishing payouts.");
    }
    const [globalSettings, profile, template, accessToken] = await Promise.all([
      supabaseAdmin!.from("whatsapp_settings").select("is_enabled").eq("company_id", companyId).maybeSingle(),
      supabaseAdmin!.from("whatsapp_profiles")
        .select("id,phone_number_id,graph_api_version,is_active")
        .eq("company_id", companyId)
        .eq("id", config.data.whatsapp_profile_id)
        .maybeSingle(),
      supabaseAdmin!.from("whatsapp_template_cache")
        .select("template_id,name,language,status,components,whatsapp_profile_id,synced_at")
        .eq("company_id", companyId)
        .eq("whatsapp_profile_id", config.data.whatsapp_profile_id)
        .eq("template_id", config.data.template_id)
        .eq("name", config.data.template_name)
        .eq("language", config.data.template_language)
        .eq("status", "APPROVED")
        .maybeSingle(),
      supabaseAdmin!.rpc("get_whatsapp_profile_access_token", { profile_id: config.data.whatsapp_profile_id })
    ]);
    if (globalSettings.error || !globalSettings.data?.is_enabled) {
      throw new Error("Enable WhatsApp messaging before publishing payouts.");
    }
    if (profile.error || !profile.data?.is_active || !profile.data.phone_number_id || accessToken.error || !accessToken.data) {
      throw new Error("The selected WhatsApp sending profile is not ready.");
    }
    if (template.error || !template.data) {
      throw new Error("The selected WhatsApp template is no longer approved. Sync templates and save the setting again.");
    }
    activeProfile = profile.data;
    approvedTemplate = template.data;
    mappings = config.data.variable_mappings as Record<string, string>;
  }

  const notifications = new Map<string, Record<string, unknown>>();
  snapshots.forEach(({ workforceId, snapshot }) => {
    const person = personById.get(workforceId);
    const values = workforcePayoutWhatsAppValues({ snapshot, person: person ?? {}, reviewUntil });
    const notificationSnapshot: Record<string, unknown> = {
      schema_version: 1,
      event_code: WORKFORCE_PAYOUT_WHATSAPP_EVENT,
      app_notification_enabled: appNotificationEnabled,
      whatsapp_notification_enabled: whatsappNotificationEnabled,
      resolved_values: values
    };
    if (whatsappNotificationEnabled && activeProfile && approvedTemplate) {
      const recipient = normalizeWorkforceWhatsAppRecipient(person?.mobile, person?.mobile_country_code);
      if (!recipient) {
        throw new Error(`${person?.dropx_id || person?.full_name || "A selected Workforce member"} does not have a valid WhatsApp mobile number.`);
      }
      buildWorkforcePayoutTemplateComponents(
        Array.isArray(approvedTemplate.components) ? approvedTemplate.components : [],
        mappings,
        values
      );
      Object.assign(notificationSnapshot, {
        whatsapp_profile_id: activeProfile.id,
        template_id: approvedTemplate.template_id,
        template_name: approvedTemplate.name,
        template_language: approvedTemplate.language,
        variable_mappings: mappings,
        template_components: approvedTemplate.components,
        recipient
      });
    }
    notifications.set(workforceId, notificationSnapshot);
  });
  return {
    appNotificationEnabled,
    config: config.data,
    notifications,
    whatsappNotificationEnabled
  };
}

function aggregateNotificationSnapshot(snapshots: PublicationSnapshot[]): PublicationSnapshot {
  const first = snapshots[0];
  if (!first) throw new Error("A selected Workforce payout is unavailable.");
  const amount = (key: "gross_amount" | "deduction_amount" | "net_amount") => snapshots
    .reduce((sum, snapshot) => sum + Number(snapshot.item[key] ?? 0), 0);
  const stations = [...new Set(snapshots.map((snapshot) => String(snapshot.item.station_code ?? "").trim()).filter(Boolean))];
  const dayUnits = new Map<string, number>();
  snapshots.flatMap((snapshot) => snapshot.lines).forEach((line) => {
    const date = String(line.work_date ?? "");
    const calculation = line.calculation_snapshot as { workDayUnits?: unknown };
    const units = Number(calculation?.workDayUnits ?? 0);
    if (date && Number.isFinite(units) && units > 0) dayUnits.set(date, Math.max(dayUnits.get(date) ?? 0, units));
  });
  const workDays = dayUnits.size
    ? [...dayUnits.values()].reduce((sum, units) => sum + units, 0)
    : snapshots.reduce((sum, snapshot) => sum + Number(snapshot.item.work_days ?? 0), 0);
  return {
    ...first,
    item: {
      ...first.item,
      station_code: stations.join(", ") || first.item.station_code,
      work_days: workDays,
      gross_amount: amount("gross_amount"),
      deduction_amount: amount("deduction_amount"),
      net_amount: amount("net_amount")
    }
  };
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return responseError("Invalid request origin.", 403);
    const authorization = await getAuthorization();
    if (!authorization) return responseError("Sign in to publish Workforce payouts.", 401);
    const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
    if (!hasPermission(authorization, pageCode, "edit")) {
      return responseError("Edit access to Workforce Payouts is required.", 403);
    }
    if (!supabaseAdmin) return responseError("Database configuration is unavailable.", 503);
    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const periodStart = String(body?.periodStart ?? "");
    const periodEnd = String(body?.periodEnd ?? "");
    const items: unknown[] = Array.isArray(body?.items) ? body.items : [];
    if (!validDate(periodStart) || !validDate(periodEnd) || periodEnd < periodStart) {
      return responseError("Select a valid payout period.", 400);
    }
    if (!items.length) return responseError("Select at least one Workforce payout.", 400);
    if (items.length > 1000) return responseError("Submit at most 1000 payouts at a time.", 400);
    if (serializedJsonByteLength(body) > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES) {
      return responseError("The selected payout request is too large. Select fewer payout rows and try again.", 413);
    }

    const normalized = items.map((source) => {
      const item = source as any;
      return {
        subject_type: item?.subjectType === "helper" ? "helper" : item?.subjectType === "workforce" ? "workforce" : "",
        subject_id: String(item?.subjectId ?? ""),
        location_id: item?.locationId ? String(item.locationId) : null,
        review_token: String(item?.reviewToken ?? ""),
        calculation_snapshot: item?.calculationSnapshot ?? item?.calculation_snapshot ?? null
      };
    });
    if (normalized.some((item) => !item.subject_type || !UUID.test(item.subject_id) || !item.location_id || !UUID.test(item.location_id))) {
      return responseError("One or more selected payouts cannot be submitted.", 400);
    }
    const uniqueSelections = new Set(normalized.map((item) => `${item.subject_id.toLowerCase()}|${item.location_id!.toLowerCase()}`));
    if (uniqueSelections.size !== normalized.length) {
      return responseError("The same Workforce payout location was selected more than once.", 400);
    }
    const subjectTypes = new Set(normalized.map((item) => item.subject_type));
    if (subjectTypes.size !== 1) return responseError("Submit Workforce and Helper payouts separately.", 400);

    if (subjectTypes.has("workforce") && normalized.length > MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION) {
      return responseError(
        `Send Notification supports at most ${MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION} payout rows in one atomic batch. Narrow the filters and try again.`,
        400
      );
    }

    if (subjectTypes.has("helper")) {
      const helperItems = normalized.map((item) => ({
        ...item,
        expected_status: workforcePayoutReviewTokenDetails(item.review_token, {
          companyId,
          subjectType: "helper",
          subjectId: item.subject_id,
          locationId: item.location_id!,
          periodStart,
          periodEnd
        })?.status ?? null
      }));
      if (helperItems.some((item) => !item.expected_status)) {
        return responseError("One or more Helper payouts are no longer ready for review. Refresh the page and select them again.", 409);
      }
      const helperResult = await supabaseAdmin.rpc("workforce_send_payouts_for_review", {
        p_company: companyId,
        p_actor: authorization.userId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_items: helperItems.map(({
          review_token: _reviewToken,
          calculation_snapshot: _calculationSnapshot,
          ...item
        }) => item),
        p_locations: authorization.hasAllLocationAccess ? null : authorization.locationScopeIds
      });
      if (helperResult.error) return responseError(helperResult.error.message, 400);
      return Response.json({
        submitted: Number(helperResult.data ?? helperItems.length),
        status: "Under Review"
      }, { headers: noStore });
    }

    if (!authorization.hasAllLocationAccess) {
      return responseError("Send Notification requires all-location access so every payout row for the DropX ID can be published and frozen together.", 403);
    }

    if (!completeCalendarMonth(periodStart, periodEnd)) {
      return responseError("Send Notification is available only for one complete calendar month.", 400);
    }

    const verified = normalized.map((item) => {
      const token = workforcePayoutReviewTokenDetails(item.review_token, {
        companyId,
        subjectType: "workforce",
        subjectId: item.subject_id,
        locationId: item.location_id!,
        periodStart,
        periodEnd
      });
      return { ...item, token };
    });
    if (verified.some((item) => !item.token?.dependencyHash
      || !item.token.publicationSnapshotHash
      || !item.token.locationSetHash)) {
      return responseError("One or more payouts are no longer ready. Refresh the page and review the recalculated amounts.", 409);
    }
    const dependencyHashes = new Set(verified.map((item) => item.token!.dependencyHash));
    if (dependencyHashes.size !== 1) {
      return responseError("The selected payouts came from different worksheet versions. Refresh the page and select them again.", 409);
    }
    const expectedDependencyHash = [...dependencyHashes][0];
    const selected = verified.map((item) => ({
      item,
      snapshot: verifiedPublicationSnapshot(item.calculation_snapshot, {
        dependencyHash: expectedDependencyHash,
        locationId: item.location_id!,
        periodEnd,
        periodStart,
        snapshotHash: item.token!.publicationSnapshotHash,
        workforceId: item.subject_id
      })
    }));
    if (selected.some(({ snapshot }) => !snapshot)) {
      return responseError("One or more selected payout amounts or payment details changed after this worksheet was displayed. Refresh and review the recalculated amounts.", 409);
    }

    const selectedSubjects = new Set(verified.map((item) => item.subject_id));
    for (const subjectId of selectedSubjects) {
      const subjectItems = verified.filter((item) => item.subject_id === subjectId);
      const expectedLocationHashes = new Set(subjectItems.map((item) => item.token!.locationSetHash));
      const submittedLocations = subjectItems
        .filter((item) => item.subject_id === subjectId)
        .map((item) => String(item.location_id));
      if (expectedLocationHashes.size !== 1
        || workforcePayoutLocationSetHash(submittedLocations) !== [...expectedLocationHashes][0]) {
        return responseError("Select every publishable location row for each DropX ID before sending its notification.", 409);
      }
    }

    const reviewUntil = new Date(Date.now() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const snapshots = selected.map(({ item, snapshot }) => ({
      workforceId: item.subject_id,
      snapshot: snapshot!
    }));
    const snapshotsByWorkforce = new Map<string, PublicationSnapshot[]>();
    snapshots.forEach(({ workforceId, snapshot }) => {
      snapshotsByWorkforce.set(workforceId, [...(snapshotsByWorkforce.get(workforceId) ?? []), snapshot]);
    });
    const notificationSnapshots = [...snapshotsByWorkforce].map(([workforceId, grouped]) => ({
      workforceId,
      snapshot: aggregateNotificationSnapshot(grouped)
    }));
    const notification = await notificationPreflight(companyId, notificationSnapshots, reviewUntil);
    const notificationPrimary = new Map<string, string>();
    for (const subjectId of selectedSubjects) {
      notificationPrimary.set(subjectId, verified
        .filter((item) => item.subject_id === subjectId)
        .map((item) => item.location_id!)
        .sort()[0]);
    }
    const publicationItems = selected.map(({ item, snapshot }) => {
      return {
        subject_type: "workforce",
        subject_id: item.subject_id,
        location_id: item.location_id,
        expected_status: item.token!.status,
        calculation_snapshot: snapshot!,
        snapshot_hash: item.token!.publicationSnapshotHash,
        notification_config_snapshot: notification.notifications.get(item.subject_id),
        notification_primary: notificationPrimary.get(item.subject_id) === item.location_id
      };
    });

    const publicationArguments = {
      p_company: companyId,
      p_actor: authorization.userId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_items: publicationItems,
      p_locations: authorization.hasAllLocationAccess ? null : authorization.locationScopeIds,
      p_expected_dependency_hash: expectedDependencyHash,
      p_review_until: reviewUntil,
      p_notify_at: new Date().toISOString(),
      p_notification_config_id: notification.config.id,
      p_notification_config_updated_at: notification.config.updated_at
    };
    const publicationBytes = serializedJsonByteLength(publicationArguments);
    if (publicationBytes > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES) {
      return responseError(
        "The selected payout details are too large to publish safely in one atomic batch. Select fewer payout rows and try again; no payouts were published.",
        413
      );
    }

    const result = await supabaseAdmin.rpc("workforce_publish_payout_notifications", publicationArguments);
    if (result.error) {
      const stale = /changed|refresh|version/i.test(result.error.message);
      return responseError(result.error.message, stale ? 409 : 400);
    }
    const publicationIds = Array.isArray(result.data?.publication_ids)
      ? result.data.publication_ids.map(String)
      : [];
    const whatsappPublicationIds = Array.isArray(result.data?.whatsapp_publication_ids)
      ? result.data.whatsapp_publication_ids.map(String)
      : [];
    const appNotificationIds = Array.isArray(result.data?.app_notification_ids)
      ? result.data.app_notification_ids.map(String)
      : [];
    const deliveryTasks: Array<Promise<unknown>> = [];
    if (whatsappPublicationIds.length) {
      deliveryTasks.push(processPayoutReviewNotifications({ publicationIds: whatsappPublicationIds }));
    }
    if (appNotificationIds.length) {
      deliveryTasks.push(processWorkforcePayoutAppNotifications({ notificationIds: appNotificationIds }));
    }
    if (deliveryTasks.length) {
      waitUntil(Promise.allSettled(deliveryTasks).then(() => undefined));
    }
    return Response.json({
      submitted: Number(result.data?.published ?? publicationIds.length),
      appNotifications: appNotificationIds.length,
      notifications: whatsappPublicationIds.length,
      publicationIds,
      whatsappNotifications: whatsappPublicationIds.length,
      status: "Notification queued"
    }, { headers: noStore });
  } catch (error) {
    return responseError(error instanceof Error ? error.message : "Unable to publish Workforce payouts.", 500);
  }
}
