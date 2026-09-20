export type AttendancePunchOutcome = {
  attendanceStatus: string;
  earlyOutMinutes: number;
  lateMinutes: number;
  scheduledEnd: string;
  scheduledStart: string;
  workHours: string;
};

export type AttendancePunchNotice = {
  body: string;
  punchType: "in" | "out";
  title: string;
};

function durationLabel(minutes: number) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  if (safeMinutes < 60) return `${safeMinutes} min`;
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function workDurationLabel(value: string) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return value || "0 min";
  return durationLabel(hours * 60 + minutes);
}

function hasClock(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function buildAttendancePunchNotice({
  outcome,
  punchOrder,
  time
}: {
  outcome: AttendancePunchOutcome;
  punchOrder: number;
  time: string;
}): AttendancePunchNotice {
  const isPunchIn = punchOrder === 1;
  const worked = workDurationLabel(outcome.workHours);
  const attendanceStatus = outcome.attendanceStatus || "Attendance updated";

  if (isPunchIn) {
    if (outcome.lateMinutes > 0) {
      const expectation = hasClock(outcome.scheduledStart)
        ? `Expected ${outcome.scheduledStart} · reported ${time}. `
        : "";
      return {
        body: `${expectation}You were ${durationLabel(outcome.lateMinutes)} late. Late penalty applies under company HR policy and will be deducted from an upcoming payment when the configured threshold is met.`,
        punchType: "in",
        title: `Punch-in captured · ${durationLabel(outcome.lateMinutes)} late`
      };
    }

    return {
      body: hasClock(outcome.scheduledStart)
        ? `Punch-in recorded at ${time}. Expected report time: ${outcome.scheduledStart}.`
        : `Punch-in recorded at ${time}.`,
      punchType: "in",
      title: "Punch-in captured"
    };
  }

  const details = [
    punchOrder > 2 ? `Latest punch recorded at ${time}; your final checkout was updated.` : `Punch-out recorded at ${time}.`,
    `Worked ${worked} · ${attendanceStatus}.`
  ];
  if (outcome.lateMinutes > 0) {
    const expectation = hasClock(outcome.scheduledStart)
      ? ` Expected report time: ${outcome.scheduledStart}.`
      : "";
    details.push(`Late arrival remains recorded (${durationLabel(outcome.lateMinutes)}).${expectation} Late penalty applies under company HR policy and will be deducted from an upcoming payment when the configured threshold is met.`);
  }
  if (outcome.earlyOutMinutes > 0) {
    const expectation = hasClock(outcome.scheduledEnd) ? ` Expected shift end: ${outcome.scheduledEnd}.` : "";
    details.push(`You punched out ${durationLabel(outcome.earlyOutMinutes)} early.${expectation} Early checkout penalty applies when worked hours are short; the applicable deduction will be made from an upcoming payment under company HR policy.`);
  }

  if (attendanceStatus === "Half Day") {
    details.push("Half-day deduction applies. If you are still working, punch in again, complete the required hours and make a final punch-out.");
  } else if (attendanceStatus === "Absent") {
    details.push("Hours are below the half-day requirement; absence deduction applies. If you are still working, punch in again, complete the required hours and make a final punch-out.");
  } else if (attendanceStatus === "Needs Review") {
    details.push("Open Attendance and regularize only if a punch is missing or the recorded outcome is incorrect.");
  } else if (attendanceStatus === "Full Day") {
    details.push("Full-day attendance completed.");
  }

  return {
    body: details.join(" "),
    punchType: "out",
    title: attendanceStatus === "Attendance updated"
      ? punchOrder > 2 ? "Final checkout updated" : "Punch-out captured"
      : punchOrder > 2 ? `Checkout updated · ${attendanceStatus}` : `Punch-out captured · ${attendanceStatus}`
  };
}
