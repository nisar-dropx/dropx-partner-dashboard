import { NextRequest } from "next/server";
import { createAttendancePunchNotification } from "@/lib/app-notifications";
import { istDate, punchLabel, rebuildAttendanceDay } from "@/lib/biometric/attendance";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type BiometricPunchPayload = {
  raw_event_id?: number | string;
  received_at?: string;
  event_type?: string;
  device_serial?: string;
  terminal_id?: string;
  trans_id?: string;
  enrolment_id?: string;
  punch_time?: string;
  source_ip?: string;
  payload?: Record<string, unknown>;
};

type DeviceRow = {
  id: string;
  company_id: string;
  location_id: string | null;
  is_active: boolean;
  model: string | null;
  status: string | null;
};

type EnrolmentRow = {
  id: string;
  enrolment_id: string;
  worker_type: string;
  employee_id: string | null;
  field_executive_id: string | null;
  profile_type: "employee" | "field_executive" | "contractor" | "vendor" | "worker" | null;
  account_id: string | null;
  location_id: string | null;
  status: string;
};

type WorkerMatch = {
  workerType: "employee" | "individual_contract";
  profileType: "employee" | "field_executive" | "contractor" | "vendor" | "worker";
  accountId: string;
  employeeId: string | null;
  fieldExecutiveId: string | null;
  locationId: string | null;
  isActive: boolean;
  dateOfJoin: string | null;
  code: string | null;
  name: string | null;
};

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function enrolmentIdCandidates(value: unknown) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return [];
  const normalized = digits.replace(/^0+/, "") || "0";
  return Array.from(new Set([normalized, digits]));
}

function cleanEnrolmentId(value: unknown) {
  return enrolmentIdCandidates(value)[0] ?? "";
}

function enrolmentPriority(
  row: Pick<EnrolmentRow, "status" | "worker_type" | "profile_type"> |
    Pick<WorkerMatch, "isActive" | "workerType" | "profileType">
) {
  const workerType = "worker_type" in row ? row.worker_type : row.workerType;
  const profileType = "profile_type" in row ? row.profile_type : row.profileType;
  const active = "status" in row ? row.status === "Active" : row.isActive;
  const profileOrder = ["employee", "contractor", "vendor", "worker", "field_executive"];
  return [
    Math.max(profileOrder.indexOf(profileType ?? (workerType === "employee" ? "employee" : "contractor")), 0),
    active ? 0 : 1
  ];
}

function hasSameCategoryDuplicate<T extends {
  profile_type?: string | null;
  profileType?: string | null;
  worker_type?: string;
  workerType?: string;
}>(rows: T[]) {
  const categories = rows.map((row) =>
    row.profile_type ?? row.profileType ?? row.worker_type ?? row.workerType ?? ""
  );
  return new Set(categories).size !== categories.length;
}

function pickPreferredEnrolment(rows: EnrolmentRow[]) {
  return rows.slice().sort((a, b) => {
    const [aType, aActive] = enrolmentPriority(a);
    const [bType, bActive] = enrolmentPriority(b);
    return aType - bType || aActive - bActive;
  })[0] ?? null;
}

function pickPreferredWorker(rows: WorkerMatch[]) {
  return rows.slice().sort((a, b) => {
    const [aType, aActive] = enrolmentPriority(a);
    const [bType, bActive] = enrolmentPriority(b);
    return aType - bType || aActive - bActive;
  })[0] ?? null;
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function parseDeviceDateTime(value: unknown) {
  const text = clean(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    return new Date(`${text.replace(" ", "T")}+05:30`);
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function resolveDevice(payload: BiometricPunchPayload, sourceIp: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const deviceSerial = clean(payload.device_serial);
  const existing = await supabaseAdmin
    .from("biometric_devices")
    .select("id, company_id, location_id, is_active, model, status")
    .eq("device_serial", deviceSerial)
    .limit(2);
  if (existing.error) throw new Error(existing.error.message);

  if ((existing.data ?? []).length > 1) {
    throw new Error("Device serial is mapped under more than one company. Use company-specific biometric webhook routing.");
  }

  const now = new Date().toISOString();
  if (existing.data?.[0]) {
    const device = existing.data[0] as DeviceRow;
    const eventType = clean(payload.event_type).toLowerCase();
    const isD01Heartbeat = clean(device.model).toUpperCase() === "D01" && eventType !== "timelog";
    let deviceStatus = "Connected";
    if (isD01Heartbeat) {
      const priorTimeLog = await supabaseAdmin
        .from("biometric_raw_events")
        .select("id")
        .eq("device_id", device.id)
        .ilike("event_type", "TimeLog")
        .limit(1)
        .maybeSingle();
      if (priorTimeLog.error) throw new Error(priorTimeLog.error.message);
      deviceStatus = priorTimeLog.data ? "Connected" : "Heartbeat only";
    }
    const { error } = await supabaseAdmin
      .from("biometric_devices")
      .update({
        terminal_id: clean(payload.terminal_id) || null,
        // A D01 heartbeat proves network reachability only. Do not claim the
        // terminal is reporting attendance until a real TimeLog is received.
        status: deviceStatus,
        last_seen_at: now,
        last_source_ip: sourceIp || null,
        updated_at: now
      })
      .eq("id", device.id)
      .eq("company_id", device.company_id);
    if (error) throw new Error(error.message);
    return device;
  }

  throw new Error("Device is not mapped in Device Master.");
}

async function createAlert({
  alertType,
  companyId,
  device,
  enrolment,
  message,
  payload,
  rawEventId,
  severity
}: {
  alertType: string;
  companyId: string;
  device: DeviceRow;
  enrolment?: EnrolmentRow | null;
  message: string;
  payload: BiometricPunchPayload;
  rawEventId?: string | null;
  severity?: string;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("biometric_alerts").insert({
    company_id: companyId,
    alert_type: alertType,
    severity: severity ?? "medium",
    enrolment_id: cleanEnrolmentId(payload.enrolment_id) || null,
    employee_id: enrolment?.employee_id ?? null,
    field_executive_id: enrolment?.field_executive_id ?? null,
    device_id: device.id,
    device_serial: clean(payload.device_serial) || null,
    punch_time: parseDeviceDateTime(payload.punch_time)?.toISOString() ?? null,
    message,
    raw_event_id: rawEventId ?? null
  });
}

async function findCurrentEnrolments(companyId: string, enrolmentId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const candidates = enrolmentIdCandidates(enrolmentId);
  if (!candidates.length) return [];

  const result = await supabaseAdmin
    .from("biometric_enrolments")
    .select("id, enrolment_id, worker_type, employee_id, field_executive_id, profile_type, account_id, location_id, status")
    .eq("company_id", companyId)
    .in("enrolment_id", candidates)
    .is("effective_to", null)
    .limit(20);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as EnrolmentRow[];
}

async function findWorkerMatches(companyId: string, enrolmentId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const admin = supabaseAdmin;
  const normalizedEnrolmentId = cleanEnrolmentId(enrolmentId);
  if (!normalizedEnrolmentId) return [];

  const nonEmployeeTables = [
    ["field_executive", "field_executives"],
    ["contractor", "contractors"],
    ["vendor", "vendors"],
    ["worker", "workers"]
  ] as const;
  const [employeeResult, ...nonEmployeeResults] = await Promise.all([
    admin
      .from("employees")
      .select("id, employee_code, full_name, biometric_id, location_id, is_active, date_of_join")
      .eq("company_id", companyId)
      .not("biometric_id", "is", null),
    ...nonEmployeeTables.map(([, table]) => admin
      .from(table)
      .select("id, dropx_id, full_name, biometric_id, location_id, is_active, date_of_join")
      .eq("company_id", companyId)
      .not("biometric_id", "is", null))
  ]);

  if (employeeResult.error) throw new Error(employeeResult.error.message);
  const nonEmployeeError = nonEmployeeResults.find((result) => result.error)?.error;
  if (nonEmployeeError) throw new Error(nonEmployeeError.message);

  const employees = (employeeResult.data ?? [])
    .filter((employee) => cleanEnrolmentId(employee.biometric_id) === normalizedEnrolmentId)
    .map((employee) => ({
    workerType: "employee" as const,
    profileType: "employee" as const,
    accountId: employee.id as string,
    employeeId: employee.id as string,
    fieldExecutiveId: null,
    locationId: employee.location_id as string | null,
    isActive: employee.is_active !== false,
    dateOfJoin: employee.date_of_join as string | null,
    code: employee.employee_code as string | null,
    name: employee.full_name as string | null
  }));

  const nonEmployees = nonEmployeeResults.flatMap((result, index) => {
    const [profileType] = nonEmployeeTables[index];
    return (result.data ?? [])
      .filter((profile) => cleanEnrolmentId(profile.biometric_id) === normalizedEnrolmentId)
      .map((profile) => ({
        workerType: "individual_contract" as const,
        profileType,
        accountId: profile.id as string,
        employeeId: null,
        fieldExecutiveId: profileType === "field_executive" ? profile.id as string : null,
        locationId: profile.location_id as string | null,
        isActive: profile.is_active !== false,
        dateOfJoin: profile.date_of_join as string | null,
        code: profile.dropx_id as string | null,
        name: profile.full_name as string | null
      }));
  });

  return [...employees, ...nonEmployees] satisfies WorkerMatch[];
}

async function createEnrolmentFromWorker({
  companyId,
  device,
  enrolmentId,
  worker
}: {
  companyId: string;
  device: DeviceRow;
  enrolmentId: string;
  worker: WorkerMatch;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const payload = {
    company_id: companyId,
    enrolment_id: cleanEnrolmentId(enrolmentId),
    worker_type: worker.workerType,
    profile_type: worker.profileType,
    account_id: worker.accountId,
    employee_id: worker.employeeId,
    field_executive_id: worker.fieldExecutiveId,
    location_id: worker.locationId ?? device.location_id,
    status: worker.isActive ? "Active" : "Inactive",
    effective_from: worker.dateOfJoin || today,
    effective_to: null,
    notes: "Auto-linked from workforce master when biometric punch was received.",
    updated_at: now
  };

  const insertResult = await supabaseAdmin
    .from("biometric_enrolments")
    .insert(payload)
    .select("id, enrolment_id, worker_type, employee_id, field_executive_id, profile_type, account_id, location_id, status")
    .single();

  if (!insertResult.error) return insertResult.data as EnrolmentRow;

  const retryRows = await findCurrentEnrolments(companyId, enrolmentId);
  if (retryRows.length === 1) return retryRows[0];
  throw new Error(insertResult.error.message);
}

async function reconcileLegacyEnrolment(
  companyId: string,
  enrolment: EnrolmentRow
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (enrolment.profile_type && enrolment.profile_type !== "field_executive") return enrolment;

  const matches = await findWorkerMatches(companyId, enrolment.enrolment_id);
  const linkedId = enrolment.account_id ?? enrolment.field_executive_id;
  const linkedContractor = matches.find((match) =>
    match.profileType === "contractor" && Boolean(linkedId) && match.accountId === linkedId
  );
  const contractorMatches = matches.filter((match) => match.profileType === "contractor");
  const fieldExecutiveMatches = matches.filter((match) => match.profileType === "field_executive");
  const contractor = linkedContractor ??
    (!linkedId && contractorMatches.length === 1 && fieldExecutiveMatches.length === 0
      ? contractorMatches[0]
      : null);
  if (!contractor) return enrolment;

  const repaired = {
    worker_type: contractor.workerType,
    profile_type: contractor.profileType,
    account_id: contractor.accountId,
    employee_id: null,
    field_executive_id: null,
    location_id: contractor.locationId ?? enrolment.location_id,
    status: contractor.isActive ? "Active" : "Inactive",
    updated_at: new Date().toISOString()
  };
  const result = await supabaseAdmin
    .from("biometric_enrolments")
    .update(repaired)
    .eq("id", enrolment.id)
    .eq("company_id", companyId)
    .select("id, enrolment_id, worker_type, employee_id, field_executive_id, profile_type, account_id, location_id, status")
    .single();
  if (result.error) throw new Error(result.error.message);
  return result.data as EnrolmentRow;
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) return jsonError("Supabase service role key is not configured.", 500);
    if (!process.env.BIOMETRIC_WEBHOOK_TOKEN) return jsonError("BIOMETRIC_WEBHOOK_TOKEN is not configured.", 500);
    if (bearerToken(request) !== process.env.BIOMETRIC_WEBHOOK_TOKEN) return jsonError("Unauthorized", 401);

    const body = await request.json().catch(() => null) as BiometricPunchPayload | null;
    if (!body) return jsonError("Invalid JSON.");

    const deviceSerial = clean(body.device_serial);
    const enrolmentId = cleanEnrolmentId(body.enrolment_id);
    const normalizedBody = { ...body, enrolment_id: enrolmentId };
    const eventType = clean(body.event_type || "TimeLog") || "TimeLog";
    const punchTime = parseDeviceDateTime(body.punch_time);
    const receivedAt = parseDeviceDateTime(body.received_at)?.toISOString() || new Date().toISOString();
    const sourceIp = clean(body.source_ip) || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";

    if (!deviceSerial) return jsonError("device_serial is required.");

    const device = await resolveDevice(body, sourceIp);
    if (!device.is_active) {
      return jsonError("Device is inactive in Device Master.", 409);
    }

    const rawPayload = {
      company_id: device.company_id,
      device_id: device.id,
      middleware_raw_event_id: body.raw_event_id ? Number(body.raw_event_id) || null : null,
      received_at: receivedAt,
      event_type: eventType,
      device_serial: deviceSerial,
      terminal_id: clean(body.terminal_id) || null,
      trans_id: clean(body.trans_id) || null,
      enrolment_id: enrolmentId || null,
      punch_time: punchTime?.toISOString() ?? null,
      source_ip: sourceIp || null,
      payload: body.payload ?? body
    };

    const rawResult = rawPayload.trans_id
      ? await supabaseAdmin
          .from("biometric_raw_events")
          .upsert(rawPayload, { onConflict: "company_id,device_serial,trans_id" })
          .select("id")
          .single()
      : await supabaseAdmin
          .from("biometric_raw_events")
          .insert(rawPayload)
          .select("id")
          .single();
    if (rawResult.error) throw new Error(rawResult.error.message);
    const rawEventId = rawResult.data.id as string;

    if (eventType.toLowerCase() !== "timelog") {
      return Response.json({ ok: true, stored: "raw_event", eventType });
    }

    if (!enrolmentId || !punchTime) {
      await createAlert({
        alertType: "bad_timelog",
        companyId: device.company_id,
        device,
        message: `Bad TimeLog received from ${deviceSerial}: missing enrolment ID or punch time.`,
        payload: normalizedBody,
        rawEventId,
        severity: "high"
      });
      return Response.json({ ok: true, stored: "raw_event", alert: "bad_timelog" });
    }

    const enrolmentRows = await findCurrentEnrolments(device.company_id, enrolmentId);
    if (enrolmentRows.length > 1 && hasSameCategoryDuplicate(enrolmentRows)) {
      await createAlert({
        alertType: "duplicate_enrolment_id",
        companyId: device.company_id,
        device,
        message: `Biometric enrolment ${enrolmentId} is mapped to more than one active worker in the same category. Punch kept raw until mapping is corrected.`,
        payload: normalizedBody,
        rawEventId,
        severity: "high"
      });
      return Response.json({ ok: true, stored: "raw_event", alert: "duplicate_enrolment_id" });
    }

    let enrolment = pickPreferredEnrolment(enrolmentRows);

    if (enrolment) {
      enrolment = await reconcileLegacyEnrolment(device.company_id, enrolment);
    }

    if (!enrolment) {
      const workers = await findWorkerMatches(device.company_id, enrolmentId);
      if (workers.length && !hasSameCategoryDuplicate(workers)) {
        const worker = pickPreferredWorker(workers);
        if (!worker) return jsonError("Unable to resolve worker for biometric punch.", 500);
        enrolment = await createEnrolmentFromWorker({
          companyId: device.company_id,
          device,
          enrolmentId,
          worker
        });
      } else if (workers.length > 1) {
        await createAlert({
          alertType: "duplicate_enrolment_id",
          companyId: device.company_id,
          device,
          message: `Biometric enrolment ${enrolmentId} exists on multiple workforce records in the same category. Punch kept raw until the duplicate is fixed.`,
          payload: normalizedBody,
          rawEventId,
          severity: "high"
        });
        return Response.json({ ok: true, stored: "raw_event", alert: "duplicate_enrolment_id" });
      } else {
        await createAlert({
          alertType: "unknown_enrolment",
          companyId: device.company_id,
          device,
          message: `Unknown biometric enrolment ${enrolmentId} punched on ${deviceSerial}.`,
          payload: normalizedBody,
          rawEventId,
          severity: "high"
        });
        return Response.json({ ok: true, stored: "raw_event", alert: "unknown_enrolment" });
      }
    }

    const canonicalEnrolmentId = enrolment.enrolment_id;
    const active = enrolment.status === "Active";
    const punchDate = istDate(punchTime);
    const existingPunches = await supabaseAdmin
      .from("attendance_punches")
      .select("id, punch_time")
      .eq("company_id", device.company_id)
      .eq("enrolment_id", canonicalEnrolmentId)
      .eq("punch_date", punchDate)
      .eq("calculated", true)
      .order("punch_time", { ascending: true });
    if (existingPunches.error) throw new Error(existingPunches.error.message);
    const punchTimestamp = punchTime.getTime();
    const alreadyStored = (existingPunches.data ?? []).some((row) =>
      new Date(row.punch_time).getTime() === punchTimestamp
    );
    const nextOrder = (existingPunches.data?.length ?? 0) + 1;

    const punchResult = await supabaseAdmin
      .from("attendance_punches")
      .upsert({
        company_id: device.company_id,
        raw_event_id: rawEventId,
        device_id: device.id,
        enrolment_id: canonicalEnrolmentId,
        worker_type: enrolment.worker_type,
        profile_type: enrolment.profile_type,
        account_id: enrolment.account_id,
        employee_id: enrolment.employee_id,
        field_executive_id: enrolment.field_executive_id,
        location_id: enrolment.location_id ?? device.location_id,
        device_serial: deviceSerial,
        punch_time: punchTime.toISOString(),
        punch_date: punchDate,
        punch_order: nextOrder,
        punch_label: punchLabel(nextOrder),
        worker_status: enrolment.status,
        calculated: active
      }, { onConflict: "company_id,device_serial,enrolment_id,punch_time" })
      .select("id")
      .single();
    if (punchResult.error) throw new Error(punchResult.error.message);

    if (!active) {
      await createAlert({
        alertType: "inactive_worker_punched",
        companyId: device.company_id,
        device,
        enrolment,
        message: `${enrolment.status} biometric enrolment ${canonicalEnrolmentId} punched on ${deviceSerial}.`,
        payload: normalizedBody,
        rawEventId,
        severity: "high"
      });
      return Response.json({ ok: true, stored: "inactive_punch", alert: "inactive_worker_punched" });
    }

    await rebuildAttendanceDay(device.company_id, canonicalEnrolmentId, punchDate);

    const profileType = enrolment.profile_type ??
      (enrolment.worker_type === "employee" ? "employee" : "contractor");
    const recipientAccountId = enrolment.account_id ??
      (profileType === "employee" ? enrolment.employee_id : enrolment.field_executive_id);
    if (!alreadyStored && recipientAccountId) {
      const firstPunchTime = existingPunches.data?.[0]?.punch_time
        ? new Date(existingPunches.data[0].punch_time)
        : punchTime;
      await createAttendancePunchNotification({
        accountId: recipientAccountId,
        companyId: device.company_id,
        firstPunchTime,
        profileType,
        punchDate,
        punchId: String(punchResult.data.id),
        punchOrder: nextOrder,
        punchTime
      });
    }

    return Response.json({
      ok: true,
      enrolmentId: canonicalEnrolmentId,
      punchDate,
      punchOrder: nextOrder,
      punchLabel: punchLabel(nextOrder)
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to process biometric punch.", 500);
  }
}
