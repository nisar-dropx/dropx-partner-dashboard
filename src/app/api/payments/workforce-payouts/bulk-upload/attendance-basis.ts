export type AttendanceInputBasis = "hours" | "days";

export type AttendancePaymentComponentBasis = {
  calculationSource: unknown;
  paySchedule: unknown;
  componentType?: unknown;
};

export type EffectiveAttendanceAllocation = {
  sourceId: string;
  workforceId: string;
  locationId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  requiredBasis: AttendanceInputBasis | null;
};

type AttendanceImportRow = {
  rowNumber: number;
  action: string;
  dropxId: string;
  inputType: string;
  workforceId: string;
  locationId: string;
  effectiveDate?: string;
  effectiveFrom: string;
  attendanceBasis: AttendanceInputBasis | null;
};

export type AttendanceBasisIssue = {
  rowNumber: number;
  dropxId: string;
  message: string;
};

function normalizedToken(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function requiredAttendanceBasisForComponents(
  components: AttendancePaymentComponentBasis[]
): AttendanceInputBasis | null {
  let hasDayBasedAttendance = false;
  for (const component of components) {
    if (normalizedToken(component.componentType) === "production"
      || normalizedToken(component.calculationSource) !== "attendance_eligibility") {
      continue;
    }
    const schedule = normalizedToken(component.paySchedule);
    // Worked minutes are mandatory whenever even one attendance component is
    // hourly. A day value cannot safely calculate a mixed hourly/day setup.
    if (schedule === "per_hour") return "hours";
    if (schedule === "per_day" || schedule === "per_month") hasDayBasedAttendance = true;
  }
  return hasDayBasedAttendance ? "days" : null;
}

function allocationApplies(
  allocation: EffectiveAttendanceAllocation,
  row: AttendanceImportRow,
  effectiveDate: string
) {
  return allocation.workforceId === row.workforceId
    && (allocation.locationId === null || allocation.locationId === row.locationId)
    && allocation.effectiveFrom <= effectiveDate
    && (allocation.effectiveTo === null || allocation.effectiveTo >= effectiveDate);
}

function workbookColumn(basis: AttendanceInputBasis) {
  return basis === "hours" ? "WORK_HOURS" : "WORK_DAYS";
}

export function validateAttendanceImportBases(
  rows: AttendanceImportRow[],
  allocations: EffectiveAttendanceAllocation[]
): AttendanceBasisIssue[] {
  const issues: AttendanceBasisIssue[] = [];
  for (const row of rows) {
    if (row.inputType !== "ATTENDANCE" || row.action !== "UPSERT" || row.attendanceBasis === null) continue;
    const effectiveDate = row.effectiveDate || row.effectiveFrom;
    if (!effectiveDate) continue;
    const suppliedColumn = workbookColumn(row.attendanceBasis);
    const applicableAllocations = allocations.filter((allocation) => allocationApplies(allocation, row, effectiveDate));

    if (!applicableAllocations.length) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `No effective payment allocation applies on ${effectiveDate} for this Workforce member and location. Configure an allocation before uploading ${suppliedColumn}.`
      });
      continue;
    }
    const attendanceAllocations = applicableAllocations.filter((allocation) => allocation.requiredBasis !== null);
    if (!attendanceAllocations.length) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `The effective payment allocation on ${effectiveDate} has no attendance-eligible hourly, daily, or monthly component. Configure the allocation before uploading ${suppliedColumn}.`
      });
      continue;
    }
    const requiredBases = [...new Set(attendanceAllocations.flatMap((allocation) =>
      allocation.requiredBasis === null ? [] : [allocation.requiredBasis]))];
    if (requiredBases.length > 1) {
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: `Conflicting attendance payment allocations apply on ${effectiveDate}: one requires WORK_HOURS and another requires WORK_DAYS. Correct the overlapping allocations before uploading attendance.`
      });
      continue;
    }
    const requiredBasis = requiredBases[0];
    if (requiredBasis !== row.attendanceBasis) {
      const requiredColumn = workbookColumn(requiredBasis);
      issues.push({
        rowNumber: row.rowNumber,
        dropxId: row.dropxId,
        message: requiredBasis === "hours"
          ? `${suppliedColumn} is not valid on ${effectiveDate} because the effective payment allocation includes hourly attendance pay. Upload ${requiredColumn} so worked minutes are available.`
          : `${suppliedColumn} is not valid on ${effectiveDate} because the effective payment allocation uses daily or monthly attendance pay. Upload ${requiredColumn}.`
      });
    }
  }
  return issues;
}
