export type WorkforcePayoutAttendanceOverrideRow = {
  id?: string | null;
  workforce_id: string;
  work_date: string;
  attendance_status: string;
  work_minutes: number | string | null;
};

export type WorkforcePayoutAttendancePeriodRow = {
  id?: string | null;
  workforce_id: string;
  station_id: string;
  attendance_basis: "hours" | "days" | string;
  effective_from: string;
  effective_to: string;
  quantity: number | string;
};

export type WorkforcePaymentFieldOverrideRow = {
  id?: string | null;
  workforce_id: string;
  station_id: string;
  payment_field_id: string;
  field_code_snapshot?: string | null;
  effective_from: string;
  effective_to: string;
  input_value: number | string;
};

/**
 * One uploaded production-unit value. The backing table retains its historical
 * `workforce_custom_production_inputs` name, but these exact-key values can
 * override either provider-reported or custom production fields.
 */
export type WorkforceProductionInputRow = {
  id?: string | null;
  workforce_id: string;
  station_id: string;
  payment_field_id: string;
  field_code_snapshot?: string | null;
  work_date: string;
  units: number | string;
};

/** @deprecated Use WorkforceProductionInputRow for new calculation code. */
export type WorkforceCustomProductionInputRow = WorkforceProductionInputRow;

export type WorkforcePayoutAttendanceRecord = {
  punch_date: string;
  status?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  work_minutes?: number | string | null;
};

type IndexedAttendanceOverride = WorkforcePayoutAttendanceOverrideRow & {
  attendance_status: "P" | "HD" | "A";
  work_minutes: number | null;
};

export type IndexedAttendancePeriod = WorkforcePayoutAttendancePeriodRow & {
  attendance_basis: "hours" | "days";
  quantity: number;
};

type IndexedPaymentFieldOverride = WorkforcePaymentFieldOverrideRow & {
  input_value: number;
};

type IndexedProductionInput = WorkforceProductionInputRow & {
  units: number;
};

export type WorkforcePayoutInputMaps = {
  attendanceByWorkforceDate: ReadonlyMap<string, IndexedAttendanceOverride>;
  attendancePeriodsByWorkforceStation: ReadonlyMap<string, readonly IndexedAttendancePeriod[]>;
  paymentFieldOverridesByWorkforceField: ReadonlyMap<string, readonly IndexedPaymentFieldOverride[]>;
  paymentFieldOverridesByWorkforceCode: ReadonlyMap<string, readonly IndexedPaymentFieldOverride[]>;
  productionByWorkforceFieldDate: ReadonlyMap<string, IndexedProductionInput>;
  productionByWorkforceCodeDate: ReadonlyMap<string, readonly IndexedProductionInput[]>;
  /** @deprecated Historical aliases retained for callers using the table name. */
  customProductionByWorkforceFieldDate: ReadonlyMap<string, IndexedProductionInput>;
  customProductionByWorkforceCodeDate: ReadonlyMap<string, readonly IndexedProductionInput[]>;
};

type WorkforcePaymentFieldLookup = {
  workforceId: string;
  stationId?: string | null;
  paymentFieldId?: string | null;
  fieldCode?: string | null;
  date: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizedCode(value: unknown) {
  return clean(value).toUpperCase();
}

function validDate(value: unknown) {
  const date = clean(value);
  if (!ISO_DATE.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function inclusiveDateCount(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

function nonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || clean(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function workMinutes(value: unknown) {
  if (value === null) return null;
  const minutes = nonNegativeNumber(value);
  return minutes !== null && Number.isInteger(minutes) && minutes <= 1440 ? minutes : undefined;
}

function attendanceStatus(value: unknown): IndexedAttendanceOverride["attendance_status"] | null {
  const status = normalizedCode(value);
  return status === "P" || status === "HD" || status === "A" ? status : null;
}

/** Matches the existing payout page's `${workforceId}|${date}` attendance key. */
export function workforcePayoutAttendanceKey(workforceId: unknown, date: unknown) {
  return `${clean(workforceId)}|${clean(date)}`;
}

function workforcePaymentFieldKey(workforceId: unknown, stationId: unknown, paymentFieldId: unknown) {
  return `${clean(workforceId)}|${clean(stationId)}|${clean(paymentFieldId)}`;
}

function workforceAttendancePeriodKey(workforceId: unknown, stationId: unknown) {
  return `${clean(workforceId)}|${clean(stationId)}`;
}

function workforcePaymentFieldCodeKey(workforceId: unknown, stationId: unknown, fieldCode: unknown) {
  return `${clean(workforceId)}|${clean(stationId)}|${normalizedCode(fieldCode)}`;
}

function workforceProductionCodeKey(workforceId: unknown, stationId: unknown, fieldCode: unknown, date: unknown) {
  return `${clean(workforceId)}|${clean(stationId)}|${normalizedCode(fieldCode)}|${clean(date)}`;
}

/** Exact field-level identity used by uploaded production-unit values. */
export function workforceProductionKey(workforceId: unknown, stationId: unknown, paymentFieldId: unknown, date: unknown) {
  return `${clean(workforceId)}|${clean(stationId)}|${clean(paymentFieldId)}|${clean(date)}`;
}

/** @deprecated Historical alias retained for callers using the table name. */
export const workforceCustomProductionKey = workforceProductionKey;

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

function sortedIntervals(rows: IndexedPaymentFieldOverride[]) {
  return rows.slice().sort((left, right) => left.effective_from.localeCompare(right.effective_from)
    || left.effective_to.localeCompare(right.effective_to)
    || clean(left.id).localeCompare(clean(right.id)));
}

/**
 * Builds company-scoped payout-input indexes from the corresponding Supabase
 * result rows. Invalid/incomplete rows are excluded instead of becoming a
 * truthy-but-unusable override. Database uniqueness remains authoritative;
 * when duplicate daily rows are supplied, the last valid row wins.
 *
 * Page usage:
 *
 * 1. Query all three tables for the selected company from
 *    `workforcePaymentMonthStart(fromDate)` through `toDate`. Include hidden
 *    mapping history needed by combined monthly thresholds; location scope is
 *    still applied to the final visible payout rows.
 * 2. Build this object once per payout request.
 * 3. Overlay `attendanceByWorkforceDate` after biometric/shipment attendance is
 *    synthesized. When that map has the date key, pass a non-shipment source to
 *    the existing hourly-pay formula so imported WORK_MINUTES remain payable.
 * 4. Resolve field values for each calculation date, before calling the payout
 *    formula. Pass `paymentFieldId` whenever available; `fieldCode` exists only
 *    for immutable component snapshots that do not contain the field id.
 * 5. Resolve uploaded units for every production rule, both for threshold
 *    inputs and final daily lines. Provider metrics remain the fallback for
 *    provider-backed fields; custom fields fall back to zero. Pass the active
 *    mapping/allocation `stationId` so one daily input cannot be reused by a
 *    simultaneous setup at another location.
 */
export function buildWorkforcePayoutInputMaps(input: {
  attendanceOverrides?: readonly WorkforcePayoutAttendanceOverrideRow[] | null;
  attendancePeriods?: readonly WorkforcePayoutAttendancePeriodRow[] | null;
  paymentFieldOverrides?: readonly WorkforcePaymentFieldOverrideRow[] | null;
  productionInputs?: readonly WorkforceProductionInputRow[] | null;
  /** @deprecated Use productionInputs for new calculation code. */
  customProductionInputs?: readonly WorkforceCustomProductionInputRow[] | null;
}): WorkforcePayoutInputMaps {
  const attendanceByWorkforceDate = new Map<string, IndexedAttendanceOverride>();
  const attendancePeriodsByWorkforceStation = new Map<string, IndexedAttendancePeriod[]>();
  const paymentFieldOverridesByWorkforceField = new Map<string, IndexedPaymentFieldOverride[]>();
  const paymentFieldOverridesByWorkforceCode = new Map<string, IndexedPaymentFieldOverride[]>();
  const productionByWorkforceFieldDate = new Map<string, IndexedProductionInput>();
  const productionByWorkforceCodeDate = new Map<string, IndexedProductionInput[]>();

  for (const row of input.attendanceOverrides ?? []) {
    const workforceId = clean(row.workforce_id);
    const workDate = clean(row.work_date);
    const status = attendanceStatus(row.attendance_status);
    const minutes = workMinutes(row.work_minutes);
    if (!workforceId || !validDate(workDate) || !status || minutes === undefined || (status === "A" && (minutes ?? 0) !== 0)) continue;
    attendanceByWorkforceDate.set(workforcePayoutAttendanceKey(workforceId, workDate), {
      ...row,
      workforce_id: workforceId,
      work_date: workDate,
      attendance_status: status,
      work_minutes: minutes
    });
  }

  for (const row of input.attendancePeriods ?? []) {
    const workforceId = clean(row.workforce_id);
    const stationId = clean(row.station_id);
    const basis = normalizedCode(row.attendance_basis).toLowerCase();
    const effectiveFrom = clean(row.effective_from);
    const effectiveTo = clean(row.effective_to);
    const quantity = nonNegativeNumber(row.quantity);
    const inclusiveDays = validDate(effectiveFrom) && validDate(effectiveTo) && effectiveTo >= effectiveFrom
      ? inclusiveDateCount(effectiveFrom, effectiveTo)
      : 0;
    if (!workforceId || !stationId || (basis !== "hours" && basis !== "days")
      || !validDate(effectiveFrom) || !validDate(effectiveTo) || effectiveTo < effectiveFrom || quantity === null
      || (basis === "days" && quantity > inclusiveDays)
      || (basis === "hours" && quantity > inclusiveDays * 24)) continue;
    append(attendancePeriodsByWorkforceStation, workforceAttendancePeriodKey(workforceId, stationId), {
      ...row,
      workforce_id: workforceId,
      station_id: stationId,
      attendance_basis: basis,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      quantity
    });
  }
  for (const [key, rows] of attendancePeriodsByWorkforceStation) {
    attendancePeriodsByWorkforceStation.set(key, rows.slice().sort((left, right) =>
      left.effective_from.localeCompare(right.effective_from)
      || left.effective_to.localeCompare(right.effective_to)
      || clean(left.id).localeCompare(clean(right.id))));
  }

  for (const row of input.paymentFieldOverrides ?? []) {
    const workforceId = clean(row.workforce_id);
    const stationId = clean(row.station_id);
    const paymentFieldId = clean(row.payment_field_id);
    const effectiveFrom = clean(row.effective_from);
    const effectiveTo = clean(row.effective_to);
    const inputValue = nonNegativeNumber(row.input_value);
    if (!workforceId || !stationId || !paymentFieldId || !validDate(effectiveFrom) || !validDate(effectiveTo)
      || effectiveTo < effectiveFrom || inputValue === null) continue;
    const indexed: IndexedPaymentFieldOverride = {
      ...row,
      workforce_id: workforceId,
      payment_field_id: paymentFieldId,
      field_code_snapshot: normalizedCode(row.field_code_snapshot) || null,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      input_value: inputValue
    };
    append(paymentFieldOverridesByWorkforceField, workforcePaymentFieldKey(workforceId, stationId, paymentFieldId), indexed);
    if (indexed.field_code_snapshot) {
      append(paymentFieldOverridesByWorkforceCode, workforcePaymentFieldCodeKey(workforceId, stationId, indexed.field_code_snapshot), indexed);
    }
  }

  for (const [key, rows] of paymentFieldOverridesByWorkforceField) {
    paymentFieldOverridesByWorkforceField.set(key, sortedIntervals(rows));
  }
  for (const [key, rows] of paymentFieldOverridesByWorkforceCode) {
    paymentFieldOverridesByWorkforceCode.set(key, sortedIntervals(rows));
  }

  const productionInputs = input.productionInputs ?? input.customProductionInputs ?? [];
  for (const row of productionInputs) {
    const workforceId = clean(row.workforce_id);
    const stationId = clean(row.station_id);
    const paymentFieldId = clean(row.payment_field_id);
    const workDate = clean(row.work_date);
    const units = nonNegativeNumber(row.units);
    if (!workforceId || !stationId || !paymentFieldId || !validDate(workDate) || units === null) continue;
    const indexed: IndexedProductionInput = {
      ...row,
      workforce_id: workforceId,
      station_id: stationId,
      payment_field_id: paymentFieldId,
      field_code_snapshot: normalizedCode(row.field_code_snapshot) || null,
      work_date: workDate,
      units
    };
    productionByWorkforceFieldDate.set(workforceProductionKey(workforceId, stationId, paymentFieldId, workDate), indexed);
  }
  // Build the code fallback from the exact-key map so a duplicate fixture obeys
  // the same last-valid-row rule as the authoritative id lookup.
  for (const indexed of productionByWorkforceFieldDate.values()) {
    if (!indexed.field_code_snapshot) continue;
    append(
      productionByWorkforceCodeDate,
      workforceProductionCodeKey(indexed.workforce_id, indexed.station_id, indexed.field_code_snapshot, indexed.work_date),
      indexed
    );
  }

  return {
    attendanceByWorkforceDate,
    attendancePeriodsByWorkforceStation,
    paymentFieldOverridesByWorkforceField,
    paymentFieldOverridesByWorkforceCode,
    productionByWorkforceFieldDate,
    productionByWorkforceCodeDate,
    customProductionByWorkforceFieldDate: productionByWorkforceFieldDate,
    customProductionByWorkforceCodeDate: productionByWorkforceCodeDate
  };
}

/**
 * Finds the one aggregate attendance value that owns a date. Database overlap
 * constraints make one row authoritative; ambiguous fixture/manual data fails
 * closed so payroll never double-counts a range.
 */
export function findWorkforcePayoutAttendancePeriod(
  maps: WorkforcePayoutInputMaps,
  lookup: { workforceId: string; stationId: string; date: string; basis?: "hours" | "days" | null }
) {
  const workforceId = clean(lookup.workforceId);
  const stationId = clean(lookup.stationId);
  const date = clean(lookup.date);
  if (!workforceId || !stationId || !validDate(date)) return undefined;
  const matches = (maps.attendancePeriodsByWorkforceStation.get(workforceAttendancePeriodKey(workforceId, stationId)) ?? [])
    .filter((row) => (!lookup.basis || row.attendance_basis === lookup.basis)
      && row.effective_from <= date && row.effective_to >= date);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Returns aggregate attendance ranges overlapping an inclusive date window.
 * The optional basis is important for mixed payment methods: WORK_HOURS must
 * replace only hourly attendance pay, while WORK_DAYS replaces only daily or
 * monthly attendance pay.
 */
export function listWorkforcePayoutAttendancePeriods(
  maps: WorkforcePayoutInputMaps,
  lookup: {
    workforceId: string;
    stationId: string;
    basis?: "hours" | "days" | null;
    from?: string | null;
    to?: string | null;
  }
) {
  const workforceId = clean(lookup.workforceId);
  const stationId = clean(lookup.stationId);
  const from = clean(lookup.from);
  const to = clean(lookup.to);
  if (!workforceId || !stationId || (from && !validDate(from)) || (to && !validDate(to)) || (from && to && to < from)) return [];
  return (maps.attendancePeriodsByWorkforceStation.get(workforceAttendancePeriodKey(workforceId, stationId)) ?? [])
    .filter((row) => (!lookup.basis || row.attendance_basis === lookup.basis)
      && (!from || row.effective_to >= from)
      && (!to || row.effective_from <= to));
}

/**
 * An invalid aggregate must block a payout only when it overlaps the rendered
 * period, or when an earlier WORK_DAYS total is part of a monthly attendance
 * entitlement that depends on the month's cumulative units.
 */
export function aggregateAttendanceIssueAffectsPayoutPeriod(input: {
  attendanceBasis: "hours" | "days";
  aggregateFrom: string;
  aggregateTo: string;
  payoutFrom: string;
  payoutTo: string;
  requiresMonthlyDayHistory?: boolean;
}) {
  if (![input.aggregateFrom, input.aggregateTo, input.payoutFrom, input.payoutTo].every(validDate)
    || input.aggregateTo < input.aggregateFrom
    || input.payoutTo < input.payoutFrom) return false;
  if (input.aggregateFrom <= input.payoutTo && input.aggregateTo >= input.payoutFrom) return true;
  return input.attendanceBasis === "days"
    && input.requiresMonthlyDayHistory === true
    && input.aggregateTo < input.payoutFrom
    && input.aggregateTo.slice(0, 7) === input.payoutFrom.slice(0, 7);
}

/** Use this provenance check when selecting the attendance source passed to hourly pay. */
export function hasWorkforcePayoutAttendanceOverride(
  maps: WorkforcePayoutInputMaps,
  workforceId: unknown,
  date: unknown
) {
  return maps.attendanceByWorkforceDate.has(workforcePayoutAttendanceKey(workforceId, date));
}

/**
 * Returns a new attendance map. Imported status always wins. An explicit minute
 * value (including zero) wins, while a blank minute value preserves biometric
 * minutes when they exist so an optional workbook cell cannot erase hourly pay.
 */
export function overlayWorkforcePayoutAttendance(
  attendanceByWorkforceDate: ReadonlyMap<string, WorkforcePayoutAttendanceRecord>,
  overridesByWorkforceDate: WorkforcePayoutInputMaps["attendanceByWorkforceDate"]
) {
  const overlaid = new Map<string, WorkforcePayoutAttendanceRecord>(attendanceByWorkforceDate);
  for (const [key, override] of overridesByWorkforceDate) {
    const current = overlaid.get(key);
    overlaid.set(key, {
      ...(current ?? {}),
      punch_date: override.work_date,
      status: override.attendance_status,
      work_minutes: override.work_minutes === null ? current?.work_minutes ?? null : override.work_minutes
    });
  }
  return overlaid;
}

function activePaymentFieldOverrides(
  maps: WorkforcePayoutInputMaps,
  lookup: WorkforcePaymentFieldLookup
) {
  const workforceId = clean(lookup.workforceId);
  const stationId = clean(lookup.stationId);
  const paymentFieldId = clean(lookup.paymentFieldId);
  const fieldCode = normalizedCode(lookup.fieldCode);
  const date = clean(lookup.date);
  if (!workforceId || !stationId || !validDate(date)) return [];

  // A supplied id is authoritative. Code fallback is intentionally used only
  // for historical component snapshots that have no payment_field_id.
  const candidates = paymentFieldId
    ? maps.paymentFieldOverridesByWorkforceField.get(workforcePaymentFieldKey(workforceId, stationId, paymentFieldId)) ?? []
    : fieldCode
      ? maps.paymentFieldOverridesByWorkforceCode.get(workforcePaymentFieldCodeKey(workforceId, stationId, fieldCode)) ?? []
      : [];
  const active = candidates.filter((row) => row.effective_from <= date && row.effective_to >= date);
  if (!paymentFieldId && new Set(active.map((row) => row.payment_field_id)).size > 1) return [];
  return active;
}

export function findWorkforcePaymentFieldOverride(
  maps: WorkforcePayoutInputMaps,
  lookup: WorkforcePaymentFieldLookup
) {
  const active = activePaymentFieldOverrides(maps, lookup);
  // The database exclusion constraint permits at most one interval for an id.
  // Keeping a deterministic final guard makes fixture/manual data safe too.
  return active.length === 1 ? active[0] : undefined;
}

/** Imported interval value wins over the configured mapping/allocation value, including zero. */
export function resolveWorkforcePaymentFieldValue<Fallback>(
  maps: WorkforcePayoutInputMaps,
  lookup: WorkforcePaymentFieldLookup & { fallbackValue: Fallback }
): number | Fallback {
  const override = findWorkforcePaymentFieldOverride(maps, lookup);
  return override ? override.input_value : lookup.fallbackValue;
}

/** Rate-named alias for call sites where payment-field input_value is a rate. */
export function resolveWorkforcePaymentFieldRate<Fallback>(
  maps: WorkforcePayoutInputMaps,
  lookup: WorkforcePaymentFieldLookup & { fallbackRate: Fallback }
): number | Fallback {
  return resolveWorkforcePaymentFieldValue(maps, { ...lookup, fallbackValue: lookup.fallbackRate });
}

export function findWorkforceProductionInput(
  maps: WorkforcePayoutInputMaps,
  lookup: { workforceId: string; stationId?: string | null; paymentFieldId?: string | null; fieldCode?: string | null; date: string }
) {
  const workforceId = clean(lookup.workforceId);
  const stationId = clean(lookup.stationId);
  const paymentFieldId = clean(lookup.paymentFieldId);
  const fieldCode = normalizedCode(lookup.fieldCode);
  const date = clean(lookup.date);
  if (!workforceId || !validDate(date)) return undefined;
  if (paymentFieldId) {
    if (!stationId) return undefined;
    return maps.productionByWorkforceFieldDate.get(workforceProductionKey(workforceId, stationId, paymentFieldId, date));
  }
  if (!fieldCode) return undefined;
  if (!stationId) return undefined;
  const candidates = maps.productionByWorkforceCodeDate.get(workforceProductionCodeKey(workforceId, stationId, fieldCode, date)) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Uploaded daily units win over provider-reported or custom fallback units, including zero. */
export function resolveWorkforceProductionUnits<Fallback>(
  maps: WorkforcePayoutInputMaps,
  lookup: { workforceId: string; stationId?: string | null; paymentFieldId?: string | null; fieldCode?: string | null; date: string; fallbackUnits: Fallback }
): number | Fallback {
  const input = findWorkforceProductionInput(maps, lookup);
  return input ? input.units : lookup.fallbackUnits;
}

/** @deprecated Historical name retained while the backing table keeps its original name. */
export function findWorkforceCustomProductionInput(
  maps: WorkforcePayoutInputMaps,
  lookup: { workforceId: string; stationId?: string | null; paymentFieldId?: string | null; fieldCode?: string | null; date: string }
) {
  return findWorkforceProductionInput(maps, lookup);
}

/** @deprecated Use resolveWorkforceProductionUnits for new calculation code. */
export function resolveWorkforceCustomProductionUnits<Fallback>(
  maps: WorkforcePayoutInputMaps,
  lookup: { workforceId: string; stationId?: string | null; paymentFieldId?: string | null; fieldCode?: string | null; date: string; fallbackUnits: Fallback }
): number | Fallback {
  return resolveWorkforceProductionUnits(maps, lookup);
}
