/** Pure helpers for A1 punch headcount — kept free of server/alias imports for node:test. */

export type HeadcountShiftSlot = "06:00" | "14:00" | "22:00";

const DEFAULT_SLOTS: HeadcountShiftSlot[] = ["06:00", "14:00", "22:00"];

/** Same codes People/HRMS uses for part-time shift evaluation (PTPC/PTSSA/PTDA). */
const PART_TIME_DESIGNATION_CODES = new Set(["PTPC", "PTSSA", "PTDA"]);

export function isPickerDesignation(input: {
  code?: string | null;
  name?: string | null;
}) {
  const code = String(input.code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const name = String(input.name ?? "")
    .toLowerCase()
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim();
  // People: PC / PTPC (see dropx-hrms approval-designation-labels).
  if (code === "PC" || code === "PTPC" || code === "PICKER") return true;
  return /\bpickers?\b/.test(name);
}

/**
 * Mirrors People `isPartTimeWorker`: employment_type, PT* designation codes,
 * or a designation name starting with "Part Time".
 */
export function isPartTimePicker(input: {
  employmentType?: string | null;
  designationCode?: string | null;
  designationName?: string | null;
}) {
  if (input.employmentType === "part_time") return true;
  const code = String(input.designationCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (PART_TIME_DESIGNATION_CODES.has(code)) return true;
  return /^part[\s-]*time\b/i.test(String(input.designationName ?? "").trim());
}

function nextShiftStartMs(
  shiftDate: string,
  shiftSlot: HeadcountShiftSlot,
  slots: string[],
) {
  const ordered = (slots.length ? slots : DEFAULT_SLOTS) as HeadcountShiftSlot[];
  const i = ordered.indexOf(shiftSlot);
  if (i < 0) throw Error("Unknown shift slot.");
  if (i < ordered.length - 1) {
    const next = ordered[i + 1]!;
    return Date.parse(`${shiftDate}T${next}:00+05:30`);
  }
  const d = new Date(`${shiftDate}T12:00:00+05:30`);
  d.setDate(d.getDate() + 1);
  const nextDate = d.toISOString().slice(0, 10);
  const next = ordered[0]!;
  return Date.parse(`${nextDate}T${next}:00+05:30`);
}

export function shiftWindowIso(
  shiftDate: string,
  shiftSlot: HeadcountShiftSlot,
  slots?: string[],
) {
  const startMs = Date.parse(`${shiftDate}T${shiftSlot}:00+05:30`);
  if (!Number.isFinite(startMs)) throw Error("Invalid shift window.");
  const endMs = nextShiftStartMs(shiftDate, shiftSlot, slots ?? DEFAULT_SLOTS);
  return {
    startMs,
    endMs,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
  };
}

export function punchDatesCovering(
  shiftDate: string,
  shiftSlot: HeadcountShiftSlot,
) {
  const dates = [shiftDate];
  if (shiftSlot === "22:00") {
    const d = new Date(`${shiftDate}T12:00:00+05:30`);
    d.setDate(d.getDate() + 1);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function buildPickerHeadcountNote(input: {
  punchedPickers: number;
  unmatchedAtStore: number;
  nonPickerAtStore: number;
}) {
  const tips: string[] = [];
  if (input.punchedPickers === 0) {
    tips.push(
      "No punched pickers found for this store/shift yet. Enter headcount manually if people aren’t registered or haven’t punched.",
    );
  } else {
    tips.push(
      "Filled from punches at this store in the shift window. Fields stay editable.",
    );
  }
  if (input.unmatchedAtStore > 0) {
    tips.push(
      `${input.unmatchedAtStore} punch${input.unmatchedAtStore === 1 ? "" : "es"} at this store couldn’t be matched to a registered picker — add them by hand.`,
    );
  }
  if (input.nonPickerAtStore > 0) {
    tips.push(
      `${input.nonPickerAtStore} punched person${input.nonPickerAtStore === 1 ? "" : "s"} aren’t coded as picker (PC/PTPC) — include them only if they were picking.`,
    );
  }
  if (input.punchedPickers > 0 && input.unmatchedAtStore === 0) {
    tips.push(
      "Edit if someone isn’t registered, hasn’t punched, or isn’t coded as a picker.",
    );
  }
  return tips.join(" ");
}
