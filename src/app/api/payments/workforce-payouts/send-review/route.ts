import { waitUntil } from "@vercel/functions";

import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  processHelperPayoutReviewNotifications,
  processPayoutReviewNotifications
} from "@/lib/payout-review-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { processWorkforcePayoutAppNotifications } from "@/lib/workforce-payout-app-notifications";
import {
  buildHelperPayoutPublicationSnapshot,
  helperPayoutPublicationSnapshotHash,
  type HelperPayoutPublicationSnapshot
} from "@/lib/helper-payout-publication";
import { loadHelperPayoutRows } from "@/lib/helper-payout-loader";
import {
  helperPayoutDependencyStateKey,
  loadHelperPayoutDependencyState,
  type HelperPayoutDependencyState
} from "@/lib/helper-payout-dependency";
import { isWorkforcePayoutCalculationPublishable } from "@/lib/workforce-payout-publication-eligibility";
import { readAllRows } from "@/lib/supabase-pagination";
import { revalidateWorkforcePayoutPublicationSelections } from "@/lib/workforce-payout-publication-revalidation";
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
import { isProvisionalPayoutDependencyHash } from "@/lib/stable-payout-worksheet";
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
const PAYOUT_DEPENDENCY_CHANGED = "Payout inputs changed after this worksheet was displayed. Refresh the page and review the recalculated amounts.";
const MAX_DEPENDENCY_REVALIDATION_ATTEMPTS = 2;
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

function verifiedHelperPublicationSnapshot(value: unknown, expected: {
  helperId: string;
  locationId: string;
  periodEnd: string;
  periodStart: string;
  snapshotHash: string;
}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<HelperPayoutPublicationSnapshot>;
  if (snapshot.schema_version !== 2
    || snapshot.source !== "helper_payout_worksheet"
    || snapshot.run?.period_start !== expected.periodStart
    || snapshot.run?.period_end !== expected.periodEnd
    || snapshot.item?.helper_id !== expected.helperId
    || snapshot.item?.station_id !== expected.locationId
    || !Array.isArray(snapshot.lines)
    || !snapshot.worksheet
    || helperPayoutPublicationSnapshotHash(snapshot as HelperPayoutPublicationSnapshot) !== expected.snapshotHash) {
    return null;
  }
  return snapshot as HelperPayoutPublicationSnapshot;
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

async function loadHelperNotificationRecipients(companyId: string, helperIds: string[]) {
  const recipients: Array<{
    id: string;
    full_name: string | null;
    dropx_id: string | null;
    mobile: string | null;
    mobile_country_code: string | null;
  }> = [];
  const uniqueIds = [...new Set(helperIds)];
  for (const idChunk of chunkValues(uniqueIds, WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK)) {
    const page = await supabaseAdmin!
      .from("helpers")
      .select("id,full_name,dropx_id,mobile,mobile_country_code")
      .eq("company_id", companyId)
      .in("id", idChunk);
    if (page.error) return { data: recipients, error: page.error, expected: uniqueIds.length };
    recipients.push(...(page.data ?? []));
  }
  return { data: recipients, error: null, expected: uniqueIds.length };
}

async function helperPublicationReplayState({
  companyId,
  periodEnd,
  periodStart,
  selections
}: {
  companyId: string;
  periodEnd: string;
  periodStart: string;
  selections: Array<{
    dependencyHash: string;
    helperId: string;
    locationId: string;
    snapshotHash: string;
    sourceChangeId: string;
  }>;
}) {
  const helperIds = [...new Set(selections.map((selection) => selection.helperId))];
  const publications: Array<{
    id: string;
    helper_id: string;
    station_id: string;
    snapshot_hash: string;
    payout_dependency_hash: string;
    payout_source_change_id: number | string;
  }> = [];
  const reviews: Array<{ subject_id: string; location_id: string; status: string }> = [];
  for (const idChunk of chunkValues(helperIds, WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK)) {
    const [publicationResult, reviewResult] = await Promise.all([
      readAllRows(supabaseAdmin!
        .from("helper_payout_publications")
        .select("id,helper_id,station_id,snapshot_hash,payout_dependency_hash,payout_source_change_id")
        .eq("company_id", companyId)
        .eq("period_start", periodStart)
        .eq("period_end", periodEnd)
        .in("helper_id", idChunk)
        .order("helper_id")
        .order("station_id")
        .order("revision", { ascending: false })
        .order("published_at", { ascending: false })
        .order("id", { ascending: false })),
      readAllRows(supabaseAdmin!
        .from("workforce_payout_review_submissions")
        .select("subject_id,location_id,status")
        .eq("company_id", companyId)
        .eq("subject_type", "helper")
        .eq("period_start", periodStart)
        .eq("period_end", periodEnd)
        .in("subject_id", idChunk)
        .order("subject_id")
        .order("location_id"))
    ]);
    if (publicationResult.error || reviewResult.error) {
      return {
        exactReplay: false,
        publicationIds: [] as string[],
        error: publicationResult.error?.message ?? reviewResult.error?.message ?? "Helper publication state is unavailable."
      };
    }
    publications.push(...((publicationResult.data ?? []) as typeof publications));
    reviews.push(...((reviewResult.data ?? []) as typeof reviews));
  }

  const latestByIdentity = new Map<string, (typeof publications)[number]>();
  for (const publication of publications) {
    const key = `${publication.helper_id.toLowerCase()}|${publication.station_id.toLowerCase()}`;
    if (!latestByIdentity.has(key)) latestByIdentity.set(key, publication);
  }
  const reviewByIdentity = new Map(reviews.map((review) => [
    `${review.subject_id.toLowerCase()}|${review.location_id.toLowerCase()}`,
    review.status
  ]));
  const exactReplay = selections.every((selection) => {
    const key = `${selection.helperId.toLowerCase()}|${selection.locationId.toLowerCase()}`;
    const latest = latestByIdentity.get(key);
    return latest?.snapshot_hash === selection.snapshotHash
      && latest?.payout_dependency_hash === selection.dependencyHash
      && String(latest?.payout_source_change_id ?? "") === selection.sourceChangeId
      && ["under_review", "approved"].includes(String(reviewByIdentity.get(key) ?? ""));
  });
  if (!exactReplay) return { exactReplay: false, publicationIds: [] as string[], error: null };

  const primaryIds: string[] = [];
  for (const helperId of helperIds) {
    const primary = selections
      .filter((selection) => selection.helperId === helperId)
      .sort((left, right) => left.locationId.localeCompare(right.locationId))[0];
    if (!primary) continue;
    const publication = latestByIdentity.get(`${primary.helperId.toLowerCase()}|${primary.locationId.toLowerCase()}`);
    if (publication) primaryIds.push(publication.id);
  }
  return { exactReplay: true, publicationIds: primaryIds, error: null };
}

async function notificationPreflight(
  companyId: string,
  snapshots: Array<{ workforceId: string; snapshot: PublicationSnapshot }>,
  reviewUntil: string,
  recipientKind: "workforce" | "helper" = "workforce"
) {
  const config = await supabaseAdmin!
    .from("whatsapp_notification_configs")
    .select("id,app_notification_enabled,is_enabled,whatsapp_profile_id,template_id,template_name,template_language,variable_mappings,updated_at")
    .eq("company_id", companyId)
    .eq("event_code", WORKFORCE_PAYOUT_WHATSAPP_EVENT)
    .maybeSingle();
  if (config.error || !config.data) {
    throw new Error("Save the Workforce & Helper payout notification setting before publishing payouts.");
  }
  const whatsappNotificationEnabled = Boolean(config.data.is_enabled);
  const appNotificationEnabled = Boolean(config.data.app_notification_enabled);
  if (!whatsappNotificationEnabled && !appNotificationEnabled) {
    throw new Error("Enable App or WhatsApp notifications before publishing payouts.");
  }

  const people = recipientKind === "helper"
    ? await loadHelperNotificationRecipients(companyId, snapshots.map((entry) => entry.workforceId))
    : await loadNotificationRecipients(companyId, snapshots.map((entry) => entry.workforceId));
  if (people.error || people.data.length !== people.expected) {
    throw new Error(`One or more selected ${recipientKind === "helper" ? "Helper" : "Workforce"} recipients are unavailable.`);
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
        throw new Error(`${person?.dropx_id || person?.full_name || `A selected ${recipientKind === "helper" ? "Helper" : "Workforce member"}`} does not have a valid WhatsApp mobile number.`);
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
      if (!authorization.hasAllLocationAccess) {
        return responseError("Send Notification requires all-location access so every payout row for the Helper can be published together.", 403);
      }
      if (!completeCalendarMonth(periodStart, periodEnd)) {
        return responseError("Send Notification is available only for one complete calendar month.", 400);
      }

      const helperItems = normalized.map((item) => {
        const token = workforcePayoutReviewTokenDetails(item.review_token, {
          companyId,
          subjectType: "helper",
          subjectId: item.subject_id,
          locationId: item.location_id!,
          periodStart,
          periodEnd
        });
        return { ...item, token };
      });
      if (helperItems.some((item) => !item.token?.publicationSnapshotHash || !item.token.locationSetHash)) {
        return responseError("One or more Helper payouts are no longer ready. Refresh the page and review the recalculated amounts.", 409);
      }

      const helperEntries = helperItems.map((item) => ({
        item,
        snapshot: verifiedHelperPublicationSnapshot(item.calculation_snapshot, {
          helperId: item.subject_id,
          locationId: item.location_id!,
          periodEnd,
          periodStart,
          snapshotHash: item.token!.publicationSnapshotHash
        })
      }));
      if (helperEntries.some((entry) => !entry.snapshot)) {
        return responseError("One or more selected Helper payout amounts changed after this worksheet was displayed. Refresh and review the recalculated amounts.", 409);
      }

      const dependencyIdentities = helperItems.map((item) => ({
        helperId: item.subject_id,
        stationId: item.location_id!
      }));
      let refreshedHelpers: Awaited<ReturnType<typeof loadHelperPayoutRows>> | null = null;
      let acceptedDependencyState: HelperPayoutDependencyState[] | null = null;
      let dependencyError: string | null = null;
      for (let attempt = 0; attempt < MAX_DEPENDENCY_REVALIDATION_ATTEMPTS; attempt += 1) {
        const before = await loadHelperPayoutDependencyState({
          companyId,
          periodEnd,
          periodStart,
          rows: dependencyIdentities
        });
        if (before.error || !before.data) {
          dependencyError = before.error ?? "Helper payout dependency state is unavailable.";
          break;
        }
        const loaded = await loadHelperPayoutRows(companyId, authorization, periodStart, periodEnd);
        if (loaded.error) {
          return responseError(`Helper payouts could not be revalidated: ${loaded.error}`, 503);
        }
        const after = await loadHelperPayoutDependencyState({
          companyId,
          periodEnd,
          periodStart,
          rows: dependencyIdentities
        });
        if (after.error || !after.data) {
          dependencyError = after.error ?? "Helper payout dependency state is unavailable.";
          break;
        }
        if (helperPayoutDependencyStateKey(before.data) === helperPayoutDependencyStateKey(after.data)) {
          refreshedHelpers = loaded;
          acceptedDependencyState = after.data;
          break;
        }
      }
      if (!refreshedHelpers || !acceptedDependencyState) {
        return responseError(
          dependencyError
            ? `Helper payouts could not be revalidated: ${dependencyError}`
            : "Helper payout inputs changed while payouts were loading. Refresh and review the recalculated amounts.",
          dependencyError ? 503 : 409
        );
      }
      const dependencyByIdentity = new Map(acceptedDependencyState.map((state) => [
        `${state.helperId.toLowerCase()}|${state.stationId.toLowerCase()}`,
        state
      ]));
      const publishableHelperRows = refreshedHelpers.rows.filter((row) => Boolean(
        row.reviewSubjectType === "helper"
        && row.reviewSubjectId
        && row.locationId
        && row.paymentDetailsAvailable
        && isWorkforcePayoutCalculationPublishable(row.status)
      ));
      const refreshedByIdentity = new Map(publishableHelperRows.map((row) => [
        `${String(row.reviewSubjectId).toLowerCase()}|${String(row.locationId).toLowerCase()}`,
        row
      ]));
      const refreshedHelperEntries = helperItems.map((item) => {
        const row = refreshedByIdentity.get(`${item.subject_id.toLowerCase()}|${item.location_id!.toLowerCase()}`);
        if (!row) return null;
        const snapshot = buildHelperPayoutPublicationSnapshot(row, periodStart, periodEnd);
        if (helperPayoutPublicationSnapshotHash(snapshot) !== item.token!.publicationSnapshotHash) return null;
        return { item, snapshot };
      });
      if (refreshedHelperEntries.some((entry) => !entry)) {
        return responseError("One or more selected Helper payout inputs changed after this worksheet was displayed. Refresh and review the recalculated amounts.", 409);
      }

      const selectedHelpers = new Set(helperItems.map((item) => item.subject_id));
      for (const helperId of selectedHelpers) {
        const subjectItems = helperItems.filter((item) => item.subject_id === helperId);
        const expectedLocationHashes = new Set(subjectItems.map((item) => item.token!.locationSetHash));
        const submittedLocations = subjectItems.map((item) => String(item.location_id));
        if (expectedLocationHashes.size !== 1
          || workforcePayoutLocationSetHash(submittedLocations) !== [...expectedLocationHashes][0]) {
          return responseError("Select every publishable location row for each Helper before sending its notification.", 409);
        }
        const currentLocations = publishableHelperRows
          .filter((row) => row.reviewSubjectId === helperId)
          .map((row) => row.locationId!);
        if (workforcePayoutLocationSetHash(currentLocations) !== [...expectedLocationHashes][0]) {
          return responseError("The Helper's publishable payout locations changed after this worksheet was displayed. Refresh and review the recalculated payouts.", 409);
        }
      }

      // If the first request committed but its HTTP response was lost, retrying
      // the exact signed snapshot is a read-only success. This check happens
      // after the full server reload and location-set validation, and it never
      // turns a changed snapshot into an idempotent replay.
      const replaySelections = refreshedHelperEntries.map((entry) => {
        const key = `${entry!.item.subject_id.toLowerCase()}|${entry!.item.location_id!.toLowerCase()}`;
        const dependency = dependencyByIdentity.get(key)!;
        return {
          dependencyHash: dependency.dependencyHash,
          helperId: entry!.item.subject_id,
          locationId: entry!.item.location_id!,
          snapshotHash: helperPayoutPublicationSnapshotHash(entry!.snapshot),
          sourceChangeId: dependency.sourceChangeId
        };
      });
      const replay = await helperPublicationReplayState({
        companyId,
        periodEnd,
        periodStart,
        selections: replaySelections
      });
      if (replay.error) {
        return responseError(`Helper publication state could not be revalidated: ${replay.error}`, 503);
      }
      if (replay.exactReplay) {
        return Response.json({
          submitted: refreshedHelperEntries.length,
          alreadyPublished: true,
          appNotifications: 0,
          notifications: 0,
          publicationIds: replay.publicationIds,
          whatsappNotifications: 0,
          status: "Already published"
        }, { headers: noStore });
      }

      const reviewUntil = new Date(Date.now() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const snapshotsByHelper = new Map<string, PublicationSnapshot[]>();
      refreshedHelperEntries.forEach((entry) => {
        const { item, snapshot } = entry!;
        snapshotsByHelper.set(item.subject_id, [
          ...(snapshotsByHelper.get(item.subject_id) ?? []),
          snapshot as unknown as PublicationSnapshot
        ]);
      });
      const notificationSnapshots = [...snapshotsByHelper].map(([helperId, grouped]) => ({
        workforceId: helperId,
        snapshot: aggregateNotificationSnapshot(grouped)
      }));
      const notification = await notificationPreflight(companyId, notificationSnapshots, reviewUntil, "helper");
      const notificationPrimary = new Map<string, string>();
      for (const helperId of selectedHelpers) {
        notificationPrimary.set(helperId, helperItems
          .filter((item) => item.subject_id === helperId)
          .map((item) => item.location_id!)
          .sort()[0]);
      }

      const publicationArguments = {
        p_company: companyId,
        p_actor: authorization.userId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_items: refreshedHelperEntries.map((entry) => {
          const { item, snapshot } = entry!;
          const dependency = dependencyByIdentity.get(
            `${item.subject_id.toLowerCase()}|${item.location_id!.toLowerCase()}`
          )!;
          return {
            subject_type: "helper",
            subject_id: item.subject_id,
            location_id: item.location_id,
            expected_status: item.token!.status,
            expected_dependency_hash: dependency.dependencyHash,
            expected_source_change_id: dependency.sourceChangeId,
            calculation_snapshot: snapshot,
            snapshot_hash: item.token!.publicationSnapshotHash,
            notification_config_snapshot: notification.notifications.get(item.subject_id),
            notification_primary: notificationPrimary.get(item.subject_id) === item.location_id
          };
        }),
        p_locations: null,
        p_review_until: reviewUntil,
        p_notify_at: new Date().toISOString(),
        p_notification_config_id: notification.config.id,
        p_notification_config_updated_at: notification.config.updated_at
      };
      if (serializedJsonByteLength(publicationArguments) > MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES) {
        return responseError("The selected Helper payout details are too large to publish safely in one batch. Select fewer rows and try again; no payouts were published.", 413);
      }
      const helperResult = await supabaseAdmin.rpc("helper_publish_payout_notifications", publicationArguments);
      if (helperResult.error) {
        // A concurrent identical request can commit while this request waits on
        // the Helper publication lock. Re-read after the RPC failure so the
        // same immutable result is returned instead of creating a duplicate.
        const concurrentReplay = await helperPublicationReplayState({
          companyId,
          periodEnd,
          periodStart,
          selections: replaySelections
        });
        if (!concurrentReplay.error && concurrentReplay.exactReplay) {
          return Response.json({
            submitted: refreshedHelperEntries.length,
            alreadyPublished: true,
            appNotifications: 0,
            notifications: 0,
            publicationIds: concurrentReplay.publicationIds,
            whatsappNotifications: 0,
            status: "Already published"
          }, { headers: noStore });
        }
        return responseError(helperResult.error.message, 400);
      }

      const publicationIds = Array.isArray(helperResult.data?.publication_ids)
        ? helperResult.data.publication_ids.map(String)
        : [];
      const whatsappPublicationIds = Array.isArray(helperResult.data?.whatsapp_publication_ids)
        ? helperResult.data.whatsapp_publication_ids.map(String)
        : [];
      const appNotificationIds = Array.isArray(helperResult.data?.app_notification_ids)
        ? helperResult.data.app_notification_ids.map(String)
        : [];
      const deliveryTasks: Array<Promise<unknown>> = [];
      if (whatsappPublicationIds.length) {
        deliveryTasks.push(processHelperPayoutReviewNotifications({ publicationIds: whatsappPublicationIds }));
      }
      if (appNotificationIds.length) {
        deliveryTasks.push(processWorkforcePayoutAppNotifications({ notificationIds: appNotificationIds }));
      }
      if (deliveryTasks.length) {
        waitUntil(Promise.allSettled(deliveryTasks).then(() => undefined));
      }
      return Response.json({
        submitted: Number(helperResult.data?.published ?? publicationIds.length),
        appNotifications: appNotificationIds.length,
        notifications: whatsappPublicationIds.length,
        publicationIds,
        whatsappNotifications: whatsappPublicationIds.length,
        status: "Notification queued"
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
      || !item.token.calculationHash
      || !item.token.publicationSnapshotHash
      || !item.token.locationSetHash)) {
      return responseError("One or more payouts are no longer ready. Refresh the page and review the recalculated amounts.", 409);
    }
    const dependencyHashes = new Set(verified.map((item) => item.token!.dependencyHash));
    if (dependencyHashes.size !== 1) {
      return responseError("The selected payouts came from different worksheet versions. Refresh the page and select them again.", 409);
    }
    let expectedDependencyHash = [...dependencyHashes][0];
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

    let publicationEntries = selected.map(({ item, snapshot }) => ({
      item,
      snapshot: snapshot!,
      snapshotHash: item.token!.publicationSnapshotHash
    }));
    const revalidatePublicationEntries = async () => {
      const refreshed = await revalidateWorkforcePayoutPublicationSelections({
        authorization,
        companyId,
        periodEnd,
        periodStart,
        selections: verified.map((item) => ({
          calculationHash: item.token!.calculationHash,
          locationId: item.location_id!,
          locationSetHash: item.token!.locationSetHash,
          subjectId: item.subject_id
        }))
      });
      if (refreshed.error || !refreshed.dependencyHash) {
        return {
          entries: null,
          dependencyHash: null,
          error: refreshed.error || "Payout inputs are updating. No notifications were sent; please try again in a moment.",
          updating: refreshed.updating
        };
      }
      const refreshedByIdentity = new Map(refreshed.entries.map((entry) => [
        `${entry.subjectId.toLowerCase()}|${entry.locationId.toLowerCase()}`,
        entry
      ]));
      return {
        entries: verified.map((item) => {
          const entry = refreshedByIdentity.get(`${item.subject_id.toLowerCase()}|${item.location_id!.toLowerCase()}`);
          if (!entry) throw new Error("A revalidated Workforce payout is unavailable.");
          return { item, snapshot: entry.snapshot, snapshotHash: entry.snapshotHash };
        }),
        dependencyHash: refreshed.dependencyHash,
        error: null,
        updating: false
      };
    };

    if (isProvisionalPayoutDependencyHash(expectedDependencyHash)) {
      const refreshed = await revalidatePublicationEntries();
      if (refreshed.error || !refreshed.dependencyHash || !refreshed.entries) {
        return responseError(refreshed.error || "Payout inputs are updating. No notifications were sent; please try again in a moment.", refreshed.updating ? 503 : 409);
      }
      publicationEntries = refreshed.entries;
      expectedDependencyHash = refreshed.dependencyHash;
    }

    const reviewUntil = new Date(Date.now() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const snapshotsByWorkforce = new Map<string, PublicationSnapshot[]>();
    publicationEntries.forEach(({ item, snapshot }) => {
      snapshotsByWorkforce.set(item.subject_id, [...(snapshotsByWorkforce.get(item.subject_id) ?? []), snapshot]);
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
    let publicationResult: any = null;
    let dependencyRevalidations = 0;
    while (true) {
      const publicationItems = publicationEntries.map(({ item, snapshot, snapshotHash }) => ({
        subject_type: "workforce",
        subject_id: item.subject_id,
        location_id: item.location_id,
        expected_status: item.token!.status,
        calculation_snapshot: snapshot,
        snapshot_hash: snapshotHash,
        notification_config_snapshot: notification.notifications.get(item.subject_id),
        notification_primary: notificationPrimary.get(item.subject_id) === item.location_id
      }));
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
      if (!result.error) {
        publicationResult = result.data;
        break;
      }
      if (!result.error.message.includes(PAYOUT_DEPENDENCY_CHANGED)) {
        const stale = /changed|refresh|version|processing/i.test(result.error.message);
        return responseError(result.error.message, stale ? 409 : 400);
      }
      if (dependencyRevalidations >= MAX_DEPENDENCY_REVALIDATION_ATTEMPTS) {
        return responseError(
          "Payout inputs are being updated right now. No notifications were sent; please try again in a moment.",
          503
        );
      }

      const refreshed = await revalidatePublicationEntries();
      if (refreshed.error || !refreshed.dependencyHash || !refreshed.entries) {
        return responseError(
          refreshed.error || "Payout inputs are updating. No notifications were sent; please try again in a moment.",
          refreshed.updating ? 503 : 409
        );
      }
      publicationEntries = refreshed.entries;
      expectedDependencyHash = refreshed.dependencyHash;
      dependencyRevalidations += 1;
    }

    const publicationIds = Array.isArray(publicationResult?.publication_ids)
      ? publicationResult.publication_ids.map(String)
      : [];
    const whatsappPublicationIds = Array.isArray(publicationResult?.whatsapp_publication_ids)
      ? publicationResult.whatsapp_publication_ids.map(String)
      : [];
    const appNotificationIds = Array.isArray(publicationResult?.app_notification_ids)
      ? publicationResult.app_notification_ids.map(String)
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
      submitted: Number(publicationResult?.published ?? publicationIds.length),
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
