import "server-only";

import { randomBytes } from "crypto";
import {
  GoogleLocationMailClient,
  GoogleWorkspaceApiError,
  GoogleWorkspaceClient
} from "@/lib/google-workspace-client";
import {
  configureCentralLocationMailboxMapping,
  locationAddressForStation
} from "@/lib/ops-pulse/location-mail";
import { supabaseAdmin } from "@/lib/supabase-admin";

function database() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

function clean(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function routeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Google station route provisioning failed.";
  const conflict = error instanceof GoogleWorkspaceApiError && error.status === 409;
  return { error: message, state: conflict ? "conflict" as const : "error" as const };
}

export async function provisionCentralLocationMailbox(input: {
  actorId: string;
  companyId: string;
  localPart: string;
}) {
  const [settingsResult, stationsResult] = await Promise.all([
    database().from("google_workspace_settings")
      .select("customer_id,primary_domain,delegated_admin_email,default_org_unit_path")
      .eq("company_id", input.companyId).maybeSingle(),
    database().from("stations").select("id,station_code,station_name")
      .eq("company_id", input.companyId).eq("is_active", true).order("station_code")
  ]);
  if (settingsResult.error || !settingsResult.data?.delegated_admin_email) {
    throw new Error(settingsResult.error?.message ?? "Google Workspace connection master is incomplete.");
  }
  if (stationsResult.error) throw new Error(stationsResult.error.message);

  const localPart = clean(input.localPart).replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "");
  if (!localPart) throw new Error("Enter a valid central mailbox name.");
  const domain = clean(settingsResult.data.primary_domain).replace(/^@/, "");
  const centralEmail = `${localPart}@${domain}`;
  const stations = stationsResult.data ?? [];
  const stationRoutes = stations.map((station) => ({
    email: locationAddressForStation(station.station_code, domain),
    station
  })).filter((entry) => entry.email !== centralEmail);
  if (stationRoutes.length > 98) {
    throw new Error(`The central Gmail identity supports at most 98 additional send-as addresses. ${stationRoutes.length} active station routes require a second central mailbox.`);
  }

  const directory = new GoogleWorkspaceClient({
    customerId: settingsResult.data.customer_id,
    delegatedAdminEmail: settingsResult.data.delegated_admin_email,
    primaryDomain: domain
  });
  let googleUser = await directory.getUser(centralEmail);
  const created = !googleUser;
  if (!googleUser) {
    googleUser = await directory.createUser({
      primaryEmail: centralEmail,
      givenName: "DropX",
      familyName: "Location Desk",
      password: `${randomBytes(30).toString("base64url")}Aa1!`,
      orgUnitPath: settingsResult.data.default_org_unit_path || "/",
      changePasswordAtNextLogin: false
    });
  }

  const now = new Date().toISOString();
  const accountResult = await database().from("google_workspace_accounts").upsert({
    company_id: input.companyId,
    google_user_id: googleUser.id,
    primary_email: clean(googleUser.primaryEmail),
    full_name: googleUser.name?.fullName || "DropX Location Desk",
    org_unit_path: googleUser.orgUnitPath || settingsResult.data.default_org_unit_path || "/",
    account_type: "service",
    account_state: googleUser.suspended ? "suspended" : "active",
    source_type: null,
    source_record_id: null,
    person_id: null,
    profile_id: null,
    designation_id: null,
    location_id: null,
    is_google_admin: Boolean(googleUser.isAdmin),
    suspended: Boolean(googleUser.suspended),
    archived: Boolean(googleUser.archived),
    last_seen_at: now,
    last_synced_at: now,
    last_error: null,
    google_etag: googleUser.etag ?? null,
    metadata: { central_location_mailbox: true, provisioned_by: input.actorId },
    updated_at: now
  }, { onConflict: "company_id,primary_email" }).select("id").single();
  if (accountResult.error) throw new Error(accountResult.error.message);

  let existingSendAs = new Map<string, string>();
  let sendAsBootstrapError: string | null = null;
  const gmail = new GoogleLocationMailClient(centralEmail);
  try {
    existingSendAs = new Map((await gmail.listSendAs()).map((entry) => [clean(entry.sendAsEmail), entry.verificationStatus ?? "accepted"]));
  } catch (error) {
    sendAsBootstrapError = error instanceof Error ? error.message : "Unable to read Gmail send-as aliases.";
  }

  const routeResults: Array<{ email: string; error?: string | null; state: "active" | "conflict" | "error" | "pending" }> = [];
  for (const entry of stationRoutes) {
    try {
      let group = await directory.getGroup(entry.email);
      if (!group) {
        group = await directory.createGroup({
          email: entry.email,
          name: `${entry.station.station_code} · ${entry.station.station_name || "DropX Location"}`,
          description: `OpsPulse station mail route for ${entry.station.station_code}. Messages are delivered to ${centralEmail}.`
        });
      }
      await directory.ensureGroupMember(group.email, centralEmail, "MANAGER");
      await directory.updateGroupSettings(group.email, {
        whoCanPostMessage: "ANYONE_CAN_POST",
        messageModerationLevel: "MODERATE_NONE"
      });
    } catch (error) {
      routeResults.push({ email: entry.email, ...routeFailure(error) });
      continue;
    }

    if (sendAsBootstrapError) {
      routeResults.push({ email: entry.email, error: sendAsBootstrapError, state: "error" });
      continue;
    }
    try {
      let verificationStatus = existingSendAs.get(entry.email);
      if (!verificationStatus) {
        const sendAs = await gmail.createSendAs({
          email: entry.email,
          displayName: `${entry.station.station_code} · ${entry.station.station_name || "DropX Location"}`
        });
        verificationStatus = sendAs.verificationStatus ?? "pending";
      }
      routeResults.push({
        email: entry.email,
        error: verificationStatus === "accepted" ? null : "Google send-as verification is pending in the central inbox.",
        state: verificationStatus === "accepted" ? "active" : "pending"
      });
    } catch (error) {
      routeResults.push({ email: entry.email, ...routeFailure(error) });
    }
  }

  const mapping = await configureCentralLocationMailboxMapping({
    actorId: input.actorId,
    routeResults,
    companyId: input.companyId,
    workspaceAccountId: accountResult.data.id
  });
  const audit = await database().from("google_workspace_audit_log").insert({
    company_id: input.companyId,
    account_id: accountResult.data.id,
    actor_user_id: input.actorId,
    action: "central_location_mailbox_provisioned",
    status: routeResults.some((result) => result.state === "error" || result.state === "conflict") ? "blocked" : "success",
    detail: {
      central_email: centralEmail,
      created,
      delivery_model: "google_group_routes",
      station_routes: stationRoutes.length,
      active_routes: routeResults.filter((result) => result.state === "active").length,
      pending_routes: routeResults.filter((result) => result.state === "pending").length,
      failed_routes: routeResults.filter((result) => ["error", "conflict"].includes(result.state)).length
    }
  });
  if (audit.error) throw new Error(audit.error.message);

  return {
    activeRoutes: routeResults.filter((result) => result.state === "active").length,
    centralEmail,
    created,
    issues: routeResults.filter((result) => result.state === "error" || result.state === "conflict").length,
    mailboxId: mapping.mailboxId,
    pendingRoutes: routeResults.filter((result) => result.state === "pending").length,
    stationRoutes: stationRoutes.length
  };
}
