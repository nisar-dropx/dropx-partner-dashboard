// Pure Report Bot rules. No imports, so node --test can load this file directly.

export type BotMode = "off" | "listen" | "live";
export type Verdict = "pass" | "fail" | "needs_review" | "not_report";
export type CheckStatus = "pass" | "fail" | "unclear";

export type AnalysisCheck = { rule: string; status: CheckStatus; note: string };
export type ExtractedField = { label: string; value: string };
export type Analysis = {
  is_report: boolean;
  matched_report_type_id: string | null;
  verdict: Verdict;
  confidence: number;
  checks: AnalysisCheck[];
  extracted_summary: string;
  /** Key values read from the image. Kept as text so the image itself never needs storing. */
  extracted_fields: ExtractedField[];
  feedback: string;
};

export type LocalClock = { date: string; minutes: number; weekday: number };

const VERDICTS = new Set<Verdict>(["pass", "fail", "needs_review", "not_report"]);
const CHECK_STATUSES = new Set<CheckStatus>(["pass", "fail", "unclear"]);
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock date, minutes since midnight and weekday in the configured zone. */
export function localClock(now: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
    weekday: WEEKDAYS[part("weekday")] ?? 0
  };
}

export function parseClockTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Accepts "9:00, 09:30 10:15"; returns sorted unique HH:MM or throws with the bad entry. No limit on how many. */
export function normalizeTimeList(raw: string): string[] {
  const entries = String(raw ?? "").split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean);
  const normalized = entries.map((entry) => {
    const padded = /^\d:\d\d$/.test(entry) ? `0${entry}` : entry;
    if (parseClockTime(padded) === null) throw new Error(`"${entry}" is not a valid time. Use 24-hour HH:MM.`);
    return padded;
  });
  // Duplicates are merged: the same time twice would only post the same reminder twice.
  return [...new Set(normalized)].sort((a, b) => (parseClockTime(a) ?? 0) - (parseClockTime(b) ?? 0));
}

/** Every `every` minutes from `start` to `end` inclusive, as HH:MM; null when the range is impossible. */
export function intervalTimes(start: string, end: string, every: number): string[] | null {
  const from = parseClockTime(start);
  const to = parseClockTime(end);
  if (from === null || to === null || !Number.isInteger(every) || every < 1 || to < from) return null;
  const times: string[] = [];
  for (let minute = from; minute <= to; minute += every) {
    times.push(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
  }
  return times;
}

export function normalizeDays(values: Array<string | number>): number[] {
  return [...new Set(values.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
}

export type ReminderStep = { minute: number; action: "send" | "skip_stale" };

/**
 * Which reminder slots are due now, identified by their time of day (minutes since
 * midnight). Tracking the last handled *time* rather than a position in the list keeps
 * this right when someone edits the reminder times mid-day. A slot older than
 * maxDelayMinutes is skipped instead of sent, so a worker outage never produces a
 * burst of stale reminders when it reconnects.
 */
export function dueReminderSteps(reminderTimes: string[], lastHandledMinute: number | null, nowMinutes: number, maxDelayMinutes: number): ReminderStep[] {
  const slots = [...new Set(reminderTimes.map(parseClockTime).filter((value): value is number => value !== null))].sort((a, b) => a - b);
  const steps: ReminderStep[] = [];
  for (const minute of slots) {
    if (lastHandledMinute !== null && minute <= lastHandledMinute) continue;
    if (nowMinutes < minute) break;
    steps.push({ minute, action: nowMinutes - minute > maxDelayMinutes ? "skip_stale" : "send" });
  }
  // Only the latest fresh slot is worth sending; earlier fresh ones would repeat it.
  const lastSend = steps.map((step) => step.action).lastIndexOf("send");
  return steps.map((step, position) => (step.action === "send" && position !== lastSend ? { ...step, action: "skip_stale" } : step));
}

/** Replaces {name} placeholders; unknown placeholders are left visible so a typo is noticed. */
export function renderTemplate(template: string, values: Record<string, string | number | null | undefined>) {
  // Text boxes submit Windows line endings; normalise so blank-line clean-up and WhatsApp agree.
  return String(template ?? "").replace(/\r\n?/g, "\n")
    .replace(/\{([a-z_]+)\}/gi, (whole, key: string) => {
      const value = values[key.toLowerCase()];
      return value === null || value === undefined ? whole : String(value);
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function displayDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-");
  return year && month && day ? `${day}-${month}-${year}` : isoDate;
}

export function formatClock(value: string) {
  const minutes = parseClockTime(value);
  if (minutes === null) return value;
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour % 12 || 12}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

export function truncateText(value: string, maxChars: number) {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(maxChars - 1, 1)).trimEnd()}…`;
}

/** JSON schema shared by both AI providers' structured-output modes. */
export function analysisJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["is_report", "matched_report_type_id", "verdict", "confidence", "checks", "extracted_summary", "extracted_fields", "feedback"],
    properties: {
      is_report: { type: "boolean", description: "True only when the image is one of the candidate report types." },
      matched_report_type_id: { anyOf: [{ type: "string" }, { type: "null" }], description: "id of the matching candidate report type, or null." },
      verdict: { type: "string", enum: ["pass", "fail", "needs_review", "not_report"] },
      confidence: { type: "number", description: "0 to 1: how sure you are of the verdict." },
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "status", "note"],
          properties: {
            rule: { type: "string" },
            status: { type: "string", enum: ["pass", "fail", "unclear"] },
            note: { type: "string" }
          }
        }
      },
      extracted_summary: { type: "string", description: "What the image shows, in one or two short sentences." },
      extracted_fields: {
        type: "array",
        description: "Key values visible in the image that the rules refer to (dates, amounts, codes, counts, station), exactly as shown. Empty when not a report.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "value"],
          properties: { label: { type: "string" }, value: { type: "string" } }
        }
      },
      feedback: { type: "string", description: "Short message to the person who posted the image." }
    }
  };
}

/** Models without a strict JSON mode sometimes wrap the object in ``` fences or a sentence. */
export function extractJsonText(text: string) {
  const trimmed = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith("{")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** Validates model output; never trusts it. Throws when it cannot be used safely. */
export function parseAnalysis(raw: unknown, candidateIds: string[]): Analysis {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI response was not a JSON object.");
  const record = value as Record<string, unknown>;
  const verdict = String(record.verdict ?? "") as Verdict;
  if (!VERDICTS.has(verdict)) throw new Error(`AI returned an unknown verdict "${String(record.verdict)}".`);
  const confidenceNumber = Number(record.confidence);
  const confidence = Number.isFinite(confidenceNumber) ? Math.min(Math.max(confidenceNumber, 0), 1) : 0;
  const matched = typeof record.matched_report_type_id === "string" && candidateIds.includes(record.matched_report_type_id)
    ? record.matched_report_type_id
    : null;
  const isReport = record.is_report === true && verdict !== "not_report";
  const checks = (Array.isArray(record.checks) ? record.checks : []).slice(0, 30).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const check = entry as Record<string, unknown>;
    const status = String(check.status ?? "") as CheckStatus;
    return [{
      rule: truncateText(String(check.rule ?? ""), 300),
      status: CHECK_STATUSES.has(status) ? status : "unclear",
      note: truncateText(String(check.note ?? ""), 400)
    }];
  });
  return {
    is_report: isReport,
    // A single candidate is unambiguous even if the model forgot to echo its id.
    matched_report_type_id: isReport ? matched ?? (candidateIds.length === 1 ? candidateIds[0] : null) : null,
    verdict: isReport ? verdict : "not_report",
    confidence,
    checks,
    extracted_summary: truncateText(String(record.extracted_summary ?? ""), 600),
    // Bounded so a chatty model can't bloat the database row.
    extracted_fields: isReport ? (Array.isArray(record.extracted_fields) ? record.extracted_fields : []).slice(0, 20).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const field = entry as Record<string, unknown>;
      const label = truncateText(String(field.label ?? ""), 60);
      const value = truncateText(String(field.value ?? ""), 200);
      return label && value ? [{ label, value }] : [];
    }) : [],
    feedback: truncateText(String(record.feedback ?? ""), 2000)
  };
}

export type DeliverySettings = { approval_mode: "manual" | "auto"; auto_send_min_confidence: number };
export type DeliveryDecision = "silent" | "needs_approval" | "auto_send";

export function decideDelivery(analysis: Analysis, settings: DeliverySettings): DeliveryDecision {
  if (!analysis.is_report || analysis.verdict === "not_report") return "silent";
  if (!analysis.feedback.trim()) return "needs_approval";
  if (settings.approval_mode !== "auto") return "needs_approval";
  if (analysis.verdict === "needs_review") return "needs_approval";
  if (analysis.checks.some((check) => check.status === "unclear")) return "needs_approval";
  return analysis.confidence >= settings.auto_send_min_confidence ? "auto_send" : "needs_approval";
}

export type FeedbackTemplateSettings = {
  feedback_template: string;
  label_pass: string;
  label_fail: string;
  label_review: string;
  max_feedback_chars: number;
};

/**
 * The review itself, for the group: failed and unclear rules with the reason. Passed
 * rules are left out so a good report gets a short reply.
 */
export function formatChecks(checks: AnalysisCheck[]) {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.status === "fail" ? "❌" : "❓"} ${check.rule}${check.note ? ` — ${check.note}` : ""}`)
    .join("\n");
}

/**
 * WhatsApp @mention for a group member. The text must carry "@<user>" and the message
 * must list the same JID in `mentions`; WhatsApp then shows the member's name and
 * notifies them. Returns null when there is no usable JID (the name is used instead).
 */
export function mentionFor(jid: string | null | undefined) {
  const match = /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(String(jid ?? ""));
  return match ? { text: `@${match[1]}`, jid: `${match[1]}@${match[2]}` } : null;
}

export function composeFeedback(
  settings: FeedbackTemplateSettings,
  values: { verdict: Verdict; feedback: string; report: string; sender: string; group: string; date: string; checks?: AnalysisCheck[] }
) {
  const label = values.verdict === "pass" ? settings.label_pass : values.verdict === "fail" ? settings.label_fail : settings.label_review;
  const body = renderTemplate(settings.feedback_template, {
    report: values.report,
    sender: values.sender || "team",
    group: values.group,
    date: values.date,
    verdict_label: label,
    feedback: values.feedback,
    checks: formatChecks(values.checks ?? [])
  });
  return truncateText(body, settings.max_feedback_chars);
}

/** Uniform random delay in [min, max] seconds; `random` is injectable for tests. */
export function randomDelaySeconds(min: number, max: number, random: () => number = Math.random) {
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(low, Math.max(min, max));
  return Math.round(low + (high - low) * random());
}

export function isGroupJid(value: string) {
  return /^[0-9-]+@g\.us$/.test(String(value ?? ""));
}

export function retryDelayMinutes(attempt: number) {
  return [1, 5, 15, 30][Math.min(Math.max(attempt - 1, 0), 3)];
}

export function senderLabel(name: string | null | undefined, jid: string | null | undefined) {
  const cleanName = String(name ?? "").trim();
  if (cleanName) return cleanName;
  const digits = String(jid ?? "").split("@")[0]?.split(":")[0] ?? "";
  return digits ? `+${digits}` : "team";
}

/** Image formats the AI providers accept, detected from the bytes, never the claimed type. */
export function sniffImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
