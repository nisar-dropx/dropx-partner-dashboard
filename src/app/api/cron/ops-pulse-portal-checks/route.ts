import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PortalSetting = {
  amazon_driver_recon_url: string | null;
  amazon_bank_deposit_url: string | null;
  portal_login_url: string | null;
  portal_username: string | null;
  portal_secret_name: string | null;
  portal_check_interval_minutes: number | string | null;
  escalation_email: string | null;
  escalation_contact: string | null;
};

type PortalRun = {
  id: string;
  company_id: string;
  location_id: string | null;
  cod_master_id: string | null;
  station_code: string;
  portal_station_code: string | null;
  check_date: string;
  check_type: "driver_reconciliation" | "prepared_deposit";
  attempt_count: number | string;
  cod_station_settings?: PortalSetting | PortalSetting[] | null;
};

type AmazonConnector = {
  id: string;
  username: string | null;
  login_url: string | null;
  base_url: string | null;
  status: string | null;
  is_enabled: boolean | null;
  sync_enabled: boolean | null;
  amazon_connector_tasks?: Array<{
    task_code: string;
    source_url: string | null;
    is_enabled: boolean | null;
    sync_interval_minutes: number | string | null;
  }> | null;
};

type SccCredentials = {
  connectorId: string;
  username: string | null;
  password: string | null;
  mfaSecret: string | null;
  loginUrl: string | null;
  urls: {
    driver_reconciliation: string | null;
    bank_deposits: string | null;
  };
};

type DriverReconciliationAssociate = {
  provider_employee_id?: unknown;
  associate_name?: unknown;
  normalized_associate_name?: unknown;
  route_code?: unknown;
  reconciliation_state?: unknown;
  pending_amount?: unknown;
  pending_details?: unknown;
  last_detail_checked_at?: unknown;
  raw_row?: unknown;
};

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PORTAL_RUN_SELECT = "id, company_id, location_id, cod_master_id, station_code, portal_station_code, check_date, check_type, attempt_count, cod_station_settings (amazon_driver_recon_url, amazon_bank_deposit_url, portal_login_url, portal_username, portal_secret_name, portal_check_interval_minutes, escalation_email, escalation_contact)";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function retryAt(minutes: number | string | null | undefined) {
  const parsed = Number(minutes ?? 30);
  const delay = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  return new Date(Date.now() + delay * 60 * 1000).toISOString();
}

async function markRun(id: string, update: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("ops_portal_check_runs")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id);
}

/** Atomically claims a run for this tick by moving it out of the claimable
 * statuses. Two overlapping minute-ticks racing the same run.id will only
 * have one succeed here (Postgres serializes the two UPDATE...WHERE
 * statements), so the loser sees zero affected rows and skips the run
 * instead of double-processing it. Plain markRun(status: "Running") had no
 * such guard. */
async function claimRun(run: PortalRun) {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from("ops_portal_check_runs")
    .update({
      status: "Running",
      error_message: null,
      last_checked_at: new Date().toISOString(),
      attempt_count: Number(run.attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .in("status", ["Queued", "Manual Review", "Error"])
    .select("id");
  if (error) return false;
  return (data ?? []).length > 0;
}

async function logRun(run: PortalRun, eventType: string, message: string, payload: Record<string, unknown> = {}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("ops_portal_check_events").insert({
    company_id: run.company_id,
    run_id: run.id,
    event_type: eventType,
    message,
    payload
  });
}

function recipients(value: string | null | undefined) {
  return String(value ?? "").split(/[;,]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

async function escalateExhaustedRun(run: PortalRun, setting: PortalSetting) {
  if (!supabaseAdmin) return;
  const { data: closure } = await supabaseAdmin
    .from("cod_day_closures")
    .select("id")
    .eq("company_id", run.company_id)
    .eq("location_id", run.location_id)
    .eq("business_date", run.check_date)
    .maybeSingle();
  const emails = recipients(setting.escalation_email);
  const whatsapp = recipients(setting.escalation_contact);
  const title = `SCC validation exhausted: ${run.station_code}`;
  const message = `${run.check_type === "driver_reconciliation" ? "Driver Reconciliation" : "Bank Deposit"} could not be validated after 3 attempts for ${run.station_code} on ${run.check_date}. Manager action or exception approval is required.${whatsapp.length ? ` WhatsApp escalation configured for: ${whatsapp.join(", ")}.` : ""}`;
  if (closure?.id) {
    await supabaseAdmin.from("cod_manager_notifications").insert({
      company_id: run.company_id,
      closure_id: closure.id,
      location_id: run.location_id,
      recipient_email: emails.join(", ") || null,
      notification_type: "SCC validation exhausted",
      title,
      message,
      email_status: emails.length ? "Pending" : "Skipped"
    });
  }
  if (emails.length) {
    try {
      await sendEmail({ body: message, companyId: run.company_id, subject: title, to: emails });
      if (closure?.id) await supabaseAdmin.from("cod_manager_notifications").update({ email_status: "Sent" }).eq("closure_id", closure.id).eq("notification_type", "SCC validation exhausted");
    } catch (error) {
      if (closure?.id) await supabaseAdmin.from("cod_manager_notifications").update({
        email_status: "Failed",
        email_error: error instanceof Error ? error.message : "Email failed"
      }).eq("closure_id", closure.id).eq("notification_type", "SCC validation exhausted");
    }
  }
  await markRun(run.id, {
    status: "Skipped",
    summary: "Three automation attempts exhausted. Escalated to manager and Control Tower.",
    error_message: "Automatic validation stopped after 3 attempts.",
    next_check_at: null,
    last_checked_at: new Date().toISOString()
  });
  await logRun(run, "retry_exhausted", message, { emails, whatsapp });
}

function normalizeText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeRosterName(value: unknown) {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stableProviderId(stationCode: string, name: string, input: unknown) {
  const explicit = normalizeText(input).replace(/[^a-z0-9_-]+/gi, "").toUpperCase();
  if (explicit && !["0", "NA", "N/A", "NULL", "-"].includes(explicit)) return explicit;
  const slug = normalizeRosterName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `SCC-${stationCode.replace(/[^A-Z0-9]+/gi, "").toUpperCase() || "STATION"}-${slug || "ASSOCIATE"}`;
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "0").replace(/[,₹\s]/g, ""));
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function associatesFromWorkerResult(result: Record<string, unknown>) {
  const direct = Array.isArray(result.associates) ? result.associates : [];
  const evidence = result.evidence && typeof result.evidence === "object" ? result.evidence as Record<string, unknown> : {};
  const evidenceRows = Array.isArray(evidence.associates) ? evidence.associates : [];
  return (direct.length ? direct : evidenceRows) as DriverReconciliationAssociate[];
}

async function upsertDriverReconciliationRoster(run: PortalRun, result: Record<string, unknown>) {
  if (!supabaseAdmin || run.check_type !== "driver_reconciliation") return { imported: 0, skipped: 0 };

  const associates = associatesFromWorkerResult(result);
  if (!associates.length) return { imported: 0, skipped: 0 };

  const seen = new Set<string>();
  const rows = associates.flatMap((associate) => {
    const associateName = normalizeText(associate.associate_name);
    const normalizedAssociateName = normalizeRosterName(associate.normalized_associate_name || associateName);
    if (!associateName || !normalizedAssociateName) return [];
    const providerEmployeeId = stableProviderId(run.station_code, associateName, associate.provider_employee_id);
    const uniqueKey = `${run.company_id}:${run.check_date}:${run.station_code}:${providerEmployeeId}`;
    if (seen.has(uniqueKey)) return [];
    seen.add(uniqueKey);
    const rawRow = associate.raw_row && typeof associate.raw_row === "object" && !Array.isArray(associate.raw_row)
      ? associate.raw_row as Record<string, unknown>
      : {};
    const directDetails = Array.isArray(associate.pending_details) ? associate.pending_details : [];
    const rawDetails = Array.isArray(rawRow.pending_details) ? rawRow.pending_details : [];
    const pendingDetails = directDetails.length ? directDetails : rawDetails;
    const pendingAmount = numberValue(associate.pending_amount);
    return [{
      company_id: run.company_id,
      location_id: run.location_id,
      station_code: run.station_code,
      portal_station_code: run.portal_station_code,
      business_date: run.check_date,
      provider_employee_id: providerEmployeeId,
      associate_name: associateName,
      normalized_associate_name: normalizedAssociateName,
      route_code: normalizeText(associate.route_code) || null,
      reconciliation_state: normalizeText(associate.reconciliation_state) || null,
      pending_amount: pendingAmount,
      pending_details: pendingDetails,
      last_detail_checked_at: pendingDetails.length || pendingAmount > 0
        ? (typeof associate.last_detail_checked_at === "string" ? associate.last_detail_checked_at : new Date().toISOString())
        : null,
      raw_row: { ...rawRow, pending_details: pendingDetails },
      source: "scc_driver_reconciliation",
      last_seen_at: new Date().toISOString()
    }];
  });

  if (!rows.length) return { imported: 0, skipped: associates.length };

  const { error } = await supabaseAdmin
    .from("cod_driver_reconciliation_roster")
    .upsert(rows, { onConflict: "company_id,business_date,station_code,provider_employee_id" });

  if (error) {
    await logRun(run, "roster_error", `Could not save SCC driver roster: ${error.message}`, { error: error.message });
    return { imported: 0, skipped: associates.length, error: error.message };
  }

  await supabaseAdmin
    .from("cod_driver_reconciliation_roster")
    .delete()
    .eq("company_id", run.company_id)
    .eq("business_date", run.check_date)
    .eq("station_code", run.station_code)
    .eq("source", "scc_driver_reconciliation")
    .in("provider_employee_id", ["DRIVER", "ID"]);

  await logRun(run, "roster_upsert", `Saved ${rows.length} SCC driver reconciliation associates.`, { imported: rows.length });
  return { imported: rows.length, skipped: associates.length - rows.length };
}

async function loadSccCredentials(companyId: string): Promise<SccCredentials | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("amazon_connectors")
    .select("id, username, login_url, base_url, status, is_enabled, sync_enabled, amazon_connector_tasks(task_code, source_url, is_enabled, sync_interval_minutes)")
    .eq("company_id", companyId)
    .eq("portal_code", "scc")
    .maybeSingle();

  if (error || !data) return null;
  const connector = data as unknown as AmazonConnector;
  if (!connector.is_enabled) return null;

  const passwordResult = await supabaseAdmin.rpc("get_amazon_connector_password", {
    connector_uuid: connector.id
  });
  const mfaResult = await supabaseAdmin.rpc("get_amazon_connector_mfa_secret", {
    connector_uuid: connector.id
  });

  const tasks = connector.amazon_connector_tasks ?? [];
  const taskUrl = (taskCode: string) => {
    const task = tasks.find((row) => row.task_code === taskCode && row.is_enabled !== false);
    return task?.source_url ?? null;
  };

  return {
    connectorId: connector.id,
    username: connector.username,
    password: typeof passwordResult.data === "string" ? passwordResult.data : null,
    mfaSecret: typeof mfaResult.data === "string" ? mfaResult.data : null,
    loginUrl: connector.login_url,
    urls: {
      driver_reconciliation: taskUrl("driver_reconciliation"),
      bank_deposits: taskUrl("prepared_deposit")
    }
  };
}

async function processRun(run: PortalRun, workerUrl: string, workerSecret: string) {
  const setting = firstRelation(run.cod_station_settings);
  if (!setting) {
    await markRun(run.id, {
      status: "Error",
      error_message: "COD Master row is missing for this portal check.",
      last_checked_at: new Date().toISOString(),
      attempt_count: Number(run.attempt_count ?? 0) + 1,
      next_check_at: retryAt(30)
    });
    return { error: 1, ok: 0 };
  }
  if (Number(run.attempt_count ?? 0) >= 3) {
    await escalateExhaustedRun(run, setting);
    return { error: 1, ok: 0 };
  }

  const claimed = await claimRun(run);
  if (!claimed) return { error: 0, ok: 0 };

  const sccCredentials = await loadSccCredentials(run.company_id);
  const username = setting.portal_username || sccCredentials?.username || null;
  const password = sccCredentials?.password || null;
  const loginUrl = setting.portal_login_url || sccCredentials?.loginUrl || "https://www.amazonlogistics.eu/station/dashboard/workitemsvisibility";
  const driverReconciliationUrl = setting.amazon_driver_recon_url || sccCredentials?.urls.driver_reconciliation || "https://www.amazonlogistics.eu/station/dashboard/driverreconciliation";
  const bankDepositsUrl = setting.amazon_bank_deposit_url || sccCredentials?.urls.bank_deposits || "https://www.amazonlogistics.eu/station/dashboard/bankdeposits";

  const requestBody = {
    run_id: run.id,
    company_id: run.company_id,
    location_id: run.location_id,
    station_code: run.station_code,
    portal_station_code: run.portal_station_code,
    check_date: run.check_date,
    check_type: run.check_type,
    login_url: loginUrl,
    username,
    password,
    mfa_secret: sccCredentials?.mfaSecret ?? null,
    secret_name: setting.portal_secret_name,
    urls: {
      driver_reconciliation: driverReconciliationUrl,
      bank_deposits: bankDepositsUrl
    },
    portal: "scc",
    task_code: run.check_type
  };

  try {
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${workerSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(210000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(result.error ?? `Worker returned HTTP ${response.status}`));

    const status = ["Pass", "Fail", "Manual Review", "Error", "Skipped"].includes(String(result.status))
      ? String(result.status)
      : "Manual Review";
    const rosterSync = await upsertDriverReconciliationRoster(run, result as Record<string, unknown>);
    const rawResult = result && typeof result === "object"
      ? { ...(result as Record<string, unknown>), roster_sync: rosterSync }
      : { roster_sync: rosterSync };

    await markRun(run.id, {
      status,
      pending_count: Number(result.pending_count ?? 0) || 0,
      pending_amount: Number(result.pending_amount ?? 0) || 0,
      summary: String(result.summary ?? "").trim() || "Portal worker completed the check.",
      evidence: result.evidence ?? {},
      raw_result: rawResult,
      error_message: status === "Error" ? String(result.error_message ?? "Portal worker returned an error.") : null,
      last_checked_at: new Date().toISOString(),
      next_check_at: ["Pass", "Fail", "Skipped"].includes(status)
        ? null
        : retryAt(setting.portal_check_interval_minutes)
    });
    await logRun(run, "worker_result", `Portal worker completed ${run.check_type}.`, rawResult);
    return { error: 0, ok: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Portal worker failed.";
    await markRun(run.id, {
      status: "Error",
      error_message: message,
      summary: "Portal check could not be completed.",
      last_checked_at: new Date().toISOString(),
      next_check_at: retryAt(setting.portal_check_interval_minutes)
    });
    await logRun(run, "worker_error", message);
    return { error: 1, ok: 0 };
  }
}

async function loadPortalRun(runId: string) {
  if (!supabaseAdmin) return { data: null, error: "Supabase service role key is not configured." };
  const { data, error } = await supabaseAdmin
    .from("ops_portal_check_runs")
    .select(PORTAL_RUN_SELECT)
    .eq("id", runId)
    .maybeSingle();

  return {
    data: data as unknown as PortalRun | null,
    error: error?.message ?? null
  };
}

async function loadRunStatus(runId: string) {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("ops_portal_check_runs")
    .select("id, status, summary, error_message, pending_count, pending_amount, raw_result, updated_at")
    .eq("id", runId)
    .maybeSingle();
  return data;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const workerUrl = process.env.OPS_PORTAL_WORKER_URL?.trim();
  const workerSecret = process.env.OPS_PORTAL_WORKER_SECRET?.trim();
  const now = new Date().toISOString();
  const staleRunningCutoff = new Date(Date.now() - 4 * 60 * 1000).toISOString();

  await supabaseAdmin
    .from("ops_portal_check_runs")
    .update({
      status: "Error",
      error_message: "Previous worker request did not return before the processing deadline.",
      summary: "Recovered a stale Running check; it will be retried.",
      next_check_at: now,
      updated_at: now
    })
    .eq("status", "Running")
    .lt("updated_at", staleRunningCutoff);

  const runsResult = await supabaseAdmin
    .from("ops_portal_check_runs")
    .select(PORTAL_RUN_SELECT)
    .in("status", ["Queued", "Manual Review", "Error"])
    .or(`next_check_at.is.null,next_check_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(10);

  if (runsResult.error) return NextResponse.json({ error: runsResult.error.message }, { status: 500 });
  const runs = (runsResult.data ?? []) as unknown as PortalRun[];

  if (!workerUrl || !workerSecret) {
    for (const run of runs) {
      await markRun(run.id, {
        status: "Error",
        error_message: "Portal worker not configured. Set OPS_PORTAL_WORKER_URL and OPS_PORTAL_WORKER_SECRET in deployment secrets.",
        summary: "Waiting for backend portal worker configuration.",
        last_checked_at: now,
        next_check_at: retryAt(60)
      });
    }
    return NextResponse.json({ processed: runs.length, ok: 0, error: runs.length, message: "Portal worker not configured." });
  }

  const totals = { ok: 0, error: 0 };
  for (const run of runs) {
    const result = await processRun(run, workerUrl, workerSecret);
    totals.ok += result.ok;
    totals.error += result.error;
  }

  return NextResponse.json({ processed: runs.length, ...totals });
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const workerUrl = process.env.OPS_PORTAL_WORKER_URL?.trim();
  const workerSecret = process.env.OPS_PORTAL_WORKER_SECRET?.trim();
  if (!workerUrl || !workerSecret) {
    return NextResponse.json({
      error: "Portal worker not configured. Set OPS_PORTAL_WORKER_URL and OPS_PORTAL_WORKER_SECRET in deployment secrets."
    }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!runId) return NextResponse.json({ error: "run_id is required." }, { status: 400 });

  const loaded = await loadPortalRun(runId);
  if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: 500 });
  if (!loaded.data) return NextResponse.json({ error: "Portal check run not found." }, { status: 404 });

  const totals = await processRun(loaded.data, workerUrl, workerSecret);
  const run = await loadRunStatus(runId);
  return NextResponse.json({ processed: 1, ...totals, run });
}
