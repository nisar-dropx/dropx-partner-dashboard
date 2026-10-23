/**
 * Auto-suggest A1 picker FT/PT headcount from attendance punches for the
 * checklist store + shift window. SI can still edit when people aren't
 * registered / haven't punched / designation is wrong.
 */
import "server-only";
import type { ShiftSlot } from "@/lib/ops-pulse/si-handover/model";
import { db } from "@/lib/ops-pulse/si-handover/server";
import {
  buildPickerHeadcountNote,
  isPartTimePicker,
  isPickerDesignation,
  punchDatesCovering,
  shiftWindowIso,
} from "@/lib/ops-pulse/si-handover/picker-headcount-logic";

export type PickerHeadcountSnapshot = {
  fullTime: number;
  partTime: number;
  punchedPickers: number;
  /** Punches in the shift window at this store that could not be tied to a person record. */
  unmatchedAtStore: number;
  /** Distinct people who punched here but aren’t designated as pickers. */
  nonPickerAtStore: number;
  shiftDate: string;
  shiftSlot: ShiftSlot;
  windowStart: string;
  windowEnd: string;
  asOf: string;
  note: string;
};

export {
  buildPickerHeadcountNote,
  isPartTimePicker,
  isPickerDesignation,
  punchDatesCovering,
  shiftWindowIso,
} from "@/lib/ops-pulse/si-handover/picker-headcount-logic";

type DailyRow = {
  id: string;
  employee_id: string | null;
  contractor_id: string | null;
  enrolment_id: string | null;
  in_time: string | null;
  punch_in_location_id: string | null;
  status: string | null;
};

type PersonMeta = {
  id: string;
  kind: "employee" | "contractor";
  employmentType: string | null;
  designationCode: string | null;
  designationName: string | null;
  postedLocationId: string | null;
};

async function loadPersonMeta(
  companyId: string,
  employeeIds: string[],
  contractorIds: string[],
): Promise<Map<string, PersonMeta>> {
  const out = new Map<string, PersonMeta>();
  const admin = db();
  const [employees, contractors, designations, engagements] = await Promise.all([
    employeeIds.length
      ? admin
          .from("employees")
          .select(
            "id,employment_type,designation_id,location_id,is_active,deleted_at",
          )
          .eq("company_id", companyId)
          .in("id", employeeIds)
      : Promise.resolve({ data: [], error: null }),
    contractorIds.length
      ? admin
          .from("contractors")
          .select(
            "id,employment_type,designation,location_id,is_active,deleted_at",
          )
          .eq("company_id", companyId)
          .in("id", contractorIds)
      : Promise.resolve({ data: [], error: null }),
    admin
      .from("designations")
      .select("id,code,name")
      .eq("company_id", companyId)
      .limit(2000),
    admin
      .from("hr_engagements")
      .select("id,worker_type,employee_id,contractor_id")
      .eq("company_id", companyId)
      .eq("status", "active")
      .limit(5000),
  ]);
  if (employees.error) throw Error(employees.error.message);
  if (contractors.error) throw Error(contractors.error.message);
  if (designations.error) throw Error(designations.error.message);
  if (engagements.error) throw Error(engagements.error.message);

  const designationById = new Map(
    (designations.data || []).map((d) => [
      d.id as string,
      { code: (d.code as string) || null, name: (d.name as string) || null },
    ]),
  );

  const engagementIds = (engagements.data || []).map((e) => e.id as string);
  const assignments = engagementIds.length
    ? await admin
        .from("hr_work_assignments")
        .select("engagement_id,location_id,designation_id,effective_from")
        .eq("company_id", companyId)
        .eq("is_primary", true)
        .in("engagement_id", engagementIds)
        .order("effective_from", { ascending: false })
        .limit(5000)
    : { data: [], error: null };
  if (assignments.error) throw Error(assignments.error.message);

  const assignmentByEngagement = new Map<
    string,
    { location_id: string | null; designation_id: string | null }
  >();
  for (const row of assignments.data || []) {
    const id = row.engagement_id as string;
    if (!assignmentByEngagement.has(id)) {
      assignmentByEngagement.set(id, {
        location_id: (row.location_id as string) || null,
        designation_id: (row.designation_id as string) || null,
      });
    }
  }

  const engagementByWorker = new Map<string, string>();
  for (const e of engagements.data || []) {
    const workerId =
      e.worker_type === "employee" ? e.employee_id : e.contractor_id;
    if (workerId) {
      engagementByWorker.set(`${e.worker_type}:${workerId}`, e.id as string);
    }
  }

  for (const emp of employees.data || []) {
    if (emp.deleted_at) continue;
    const engId = engagementByWorker.get(`employee:${emp.id}`);
    const assignment = engId ? assignmentByEngagement.get(engId) : null;
    const designationId =
      assignment?.designation_id || (emp.designation_id as string) || null;
    const designation = designationId
      ? designationById.get(designationId)
      : null;
    out.set(`employee:${emp.id}`, {
      id: emp.id as string,
      kind: "employee",
      employmentType: (emp.employment_type as string) || null,
      designationCode: designation?.code ?? null,
      designationName: designation?.name ?? null,
      postedLocationId:
        assignment?.location_id || (emp.location_id as string) || null,
    });
  }

  for (const con of contractors.data || []) {
    if (con.deleted_at) continue;
    const engId = engagementByWorker.get(`contractor:${con.id}`);
    const assignment = engId ? assignmentByEngagement.get(engId) : null;
    const designationId = assignment?.designation_id || null;
    const designation = designationId
      ? designationById.get(designationId)
      : null;
    out.set(`contractor:${con.id}`, {
      id: con.id as string,
      kind: "contractor",
      employmentType: (con.employment_type as string) || null,
      designationCode: designation?.code ?? null,
      designationName:
        designation?.name || (con.designation as string) || null,
      postedLocationId:
        assignment?.location_id || (con.location_id as string) || null,
    });
  }

  return out;
}

export async function loadPickerHeadcountFromPunches(input: {
  companyId: string;
  locationId: string;
  shiftDate: string;
  shiftSlot: ShiftSlot;
  shiftSlots?: string[];
}): Promise<PickerHeadcountSnapshot> {
  const { startMs, endMs, windowStart, windowEnd } = shiftWindowIso(
    input.shiftDate,
    input.shiftSlot,
    input.shiftSlots,
  );
  const dates = punchDatesCovering(input.shiftDate, input.shiftSlot);
  const admin = db();

  // Prefer store punches; keep null location rows so we can fall back to
  // the worker’s posted station (common when device geo wasn’t written).
  const daily = await admin
    .from("attendance_daily")
    .select(
      "id,employee_id,contractor_id,enrolment_id,in_time,punch_in_location_id,status",
    )
    .eq("company_id", input.companyId)
    .in("punch_date", dates)
    .not("in_time", "is", null)
    .neq("status", "U")
    .or(
      `punch_in_location_id.eq.${input.locationId},punch_in_location_id.is.null`,
    )
    .limit(8000);
  if (daily.error) throw Error(daily.error.message);

  const inWindow = ((daily.data || []) as DailyRow[]).filter((row) => {
    if (!row.in_time) return false;
    const t = Date.parse(row.in_time);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) return false;
    return true;
  });

  const employeeIds = [
    ...new Set(
      inWindow
        .map((r) => r.employee_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const contractorIds = [
    ...new Set(
      inWindow
        .map((r) => r.contractor_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const people = await loadPersonMeta(
    input.companyId,
    employeeIds,
    contractorIds,
  );

  const seen = new Set<string>();
  let fullTime = 0;
  let partTime = 0;
  let unmatchedAtStore = 0;
  let nonPickerAtStore = 0;

  for (const row of inWindow) {
    const key = row.employee_id
      ? `employee:${row.employee_id}`
      : row.contractor_id
        ? `contractor:${row.contractor_id}`
        : row.enrolment_id
          ? `enrolment:${row.enrolment_id}`
          : `row:${row.id}`;
    if (seen.has(key)) continue;

    const person = row.employee_id
      ? people.get(`employee:${row.employee_id}`)
      : row.contractor_id
        ? people.get(`contractor:${row.contractor_id}`)
        : null;

    const atStore =
      row.punch_in_location_id === input.locationId ||
      (!row.punch_in_location_id &&
        person?.postedLocationId === input.locationId);
    if (!atStore) continue;

    seen.add(key);

    if (!person) {
      // Enrolment-only / deleted / unknown — SI must type these in.
      unmatchedAtStore += 1;
      continue;
    }

    if (
      !isPickerDesignation({
        code: person.designationCode,
        name: person.designationName,
      })
    ) {
      nonPickerAtStore += 1;
      continue;
    }

    if (
      isPartTimePicker({
        employmentType: person.employmentType,
        designationCode: person.designationCode,
        designationName: person.designationName,
      })
    ) {
      partTime += 1;
    } else {
      fullTime += 1;
    }
  }

  const punchedPickers = fullTime + partTime;
  return {
    fullTime,
    partTime,
    punchedPickers,
    unmatchedAtStore,
    nonPickerAtStore,
    shiftDate: input.shiftDate,
    shiftSlot: input.shiftSlot,
    windowStart,
    windowEnd,
    asOf: new Date().toISOString(),
    note: buildPickerHeadcountNote({
      punchedPickers,
      unmatchedAtStore,
      nonPickerAtStore,
    }),
  };
}
