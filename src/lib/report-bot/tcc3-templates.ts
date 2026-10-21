/**
 * TCC3 War Room report-type catalog for the Report Bot portal.
 * Installed per company via an explicit action — never hardcoded in the worker,
 * and never auto-applied to a production group.
 */

export type Tcc3Template = {
  slug: string;
  name: string;
  category: string;
  auto_reply_policy: "never" | "normal";
  subtypes: string[];
  description: string;
  feedback_hint: string;
  rules: string[];
  /** Draft schedule seed shape; created inactive until a manager enables it. */
  schedule?: {
    schedule_kind: "timed" | "interval" | "event_driven";
    due_time: string;
    reminder_times: string[];
    stop_when_received: boolean;
    review_only: boolean;
    first_reminder_template: string;
    followup_template: string;
    overdue_template: string | null;
  };
};

export const TCC3_REPORT_TEMPLATES: Tcc3Template[] = [
  {
    slug: "load-receipt",
    name: "Load receipt",
    category: "load",
    auto_reply_policy: "normal",
    subtypes: ["Dry 1", "Dry 2", "Chiller", "Frozen", "F&V", "Milk"],
    description: "Inbound load receipt with evidence. Subtypes: Dry 1, Dry 2, Chiller, Frozen, F&V, Milk.",
    feedback_hint: "Load receipt noted. Please share the shortage/TT reference and final tote reconciliation status.",
    rules: [
      "Identify load subtype (Dry 1, Dry 2, Chiller, Frozen, F&V, or Milk).",
      "Report includes a clear time or timestamp for the load.",
      "At least one evidence image is attached or clearly referenced.",
      "If shortage, damage, missing tote or return is mentioned: a count is stated.",
      "If shortage, damage, missing tote or return is mentioned: a ticket/TT reference is present.",
      "Never invent tote counts or ticket numbers that are not stated."
    ],
    schedule: {
      schedule_kind: "event_driven",
      due_time: "23:59",
      reminder_times: [],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Please share the *{report}* with evidence for {date}.",
      followup_template: "Still waiting for *{report}* evidence for {date}.",
      overdue_template: null
    }
  },
  {
    slug: "shift-plan",
    name: "Shift plan / pre-shift plan",
    category: "shift",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Pre-shift staffing and priority plan before the shift starts.",
    feedback_hint: "Shift plan received. Confirm manpower numbers and the in-charge if anything is still missing.",
    rules: [
      "Shift is identified (name or time window).",
      "Staffing/manpower plan is stated.",
      "Key target or priority for the shift is stated.",
      "Responsible in-charge is named."
    ],
    schedule: {
      schedule_kind: "timed",
      due_time: "06:00",
      reminder_times: ["05:30", "05:50"],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Good morning {group}. Please share today's *{report}* by {due_time}.",
      followup_template: "Reminder: *{report}* for {date} is still pending.",
      overdue_template: "*{report}* for {date} is overdue. Please share the plan now."
    }
  },
  {
    slug: "shift-handover",
    name: "Shift handover / device handover",
    category: "shift",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Outgoing/incoming owner handover with open operational items.",
    feedback_hint: "Handover noted. Please confirm open items and any pending evidence.",
    rules: [
      "Outgoing owner is identified.",
      "Incoming owner is identified.",
      "Shift being handed over is stated.",
      "Open operational items are listed or explicitly stated as none.",
      "Evidence is attached when relevant to open items."
    ],
    schedule: {
      schedule_kind: "timed",
      due_time: "14:00",
      reminder_times: ["13:45", "14:00"],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "{group}: please post the *{report}* by {due_time}.",
      followup_template: "Reminder: *{report}* for {date} is still pending.",
      overdue_template: "*{report}* is overdue for {date}."
    }
  },
  {
    slug: "hourly-ops",
    name: "Hourly operations update",
    category: "metrics",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Hourly PPI, O2A/speed, status and significant exceptions. Read screenshot values only when legible.",
    feedback_hint: "Hourly update noted. Please resend a clearer screenshot if any metric is unreadable.",
    rules: [
      "PPI value is present and legible, or explicitly marked unavailable.",
      "O2A or speed metric is present and legible, or explicitly marked unavailable.",
      "Operational status is stated.",
      "Any significant exception is described, or explicitly none.",
      "Never invent metric numbers that are not clearly legible."
    ],
    schedule: {
      schedule_kind: "interval",
      due_time: "22:00",
      reminder_times: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"],
      stop_when_received: false,
      review_only: true,
      first_reminder_template: "{group}: please share the hourly *{report}* now.",
      followup_template: "Hourly *{report}* still pending for this slot ({date}).",
      overdue_template: null
    }
  },
  {
    slug: "expiry-fefo",
    name: "Expiry / FEFO / dump clearance",
    category: "expiry",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Expiry, FEFO or dump clearance with evidence and outstanding quantity.",
    feedback_hint: "FEFO/expiry update noted. Track any outstanding quantity until closure.",
    rules: [
      "Action completed is stated (cleared, dumped, pending, etc.).",
      "Evidence is attached or clearly referenced.",
      "Outstanding quantity is stated when anything remains pending.",
      "When pending expiry is mentioned, treat it as an open action until closure."
    ],
    schedule: {
      schedule_kind: "timed",
      due_time: "11:00",
      reminder_times: ["10:30", "11:00"],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Please share today's *{report}* with evidence by {due_time}.",
      followup_template: "Reminder: *{report}* for {date} is still pending.",
      overdue_template: "*{report}* for {date} is overdue."
    }
  },
  {
    slug: "temperature-check",
    name: "Temperature / cold-chain check",
    category: "cold_chain",
    auto_reply_policy: "never",
    subtypes: [],
    description: "Zone/product temperature check. Failed or unclear evidence is always needs-review.",
    feedback_hint: "Temperature check needs manager review. Please share clearer evidence and the corrective action.",
    rules: [
      "Zone or product is identified.",
      "Measured temperature or clear temperature evidence is present.",
      "Action taken (or required) is stated.",
      "Failed or unclear temperature evidence must be needs_review — never automatic pass."
    ],
    schedule: {
      schedule_kind: "event_driven",
      due_time: "23:59",
      reminder_times: [],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Follow up: unresolved *{report}* still needs evidence.",
      followup_template: "High-risk temperature follow-up still open for {date}.",
      overdue_template: null
    }
  },
  {
    slug: "site-summary",
    name: "Site summary",
    category: "summary",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Structured summary of loads, manpower, metrics, incidents, tickets and pending actions.",
    feedback_hint: "Site summary received. Fill any missing sections (loads, manpower, open tickets).",
    rules: [
      "Loads received (or none) are summarised.",
      "Manpower/attendance position is summarised.",
      "Key metrics or exceptions are summarised.",
      "Open incidents and tickets are listed or stated as none.",
      "Pending actions are listed or stated as none."
    ],
    schedule: {
      schedule_kind: "timed",
      due_time: "22:00",
      reminder_times: ["21:30", "22:00"],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "{group}: please share the *{report}* by {due_time}.",
      followup_template: "Reminder: *{report}* for {date} is still pending.",
      overdue_template: "*{report}* for {date} is overdue."
    }
  },
  {
    slug: "infrastructure-incident",
    name: "Infrastructure incident",
    category: "infrastructure",
    auto_reply_policy: "never",
    subtypes: [],
    description: "Power, DG, UPS/network, door, chiller/frozen/tropical temperature infrastructure issues. Always review-only.",
    feedback_hint: "Infrastructure incident logged for manager review. Confirm impact, owner and ticket/escalation status.",
    rules: [
      "Incident type is identified (power, DG, UPS/network, door, temperature infrastructure, other).",
      "Start time is stated.",
      "Operational impact is described.",
      "Evidence is attached or clearly referenced.",
      "Owner is identified.",
      "Escalation or ticket status is stated.",
      "Never automatically send an escalation decision."
    ],
    schedule: {
      schedule_kind: "event_driven",
      due_time: "23:59",
      reminder_times: [],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Follow up: unresolved infrastructure incident still needs an update.",
      followup_template: "High-risk infrastructure follow-up still open for {date}.",
      overdue_template: null
    }
  },
  {
    slug: "workforce-exception",
    name: "Workforce/attendance exception",
    category: "workforce",
    auto_reply_policy: "never",
    subtypes: [],
    description: "No show, late coming, security absence, new joiner or manpower gap. Review-only by default.",
    feedback_hint: "Attendance/manpower exception logged for review. Confirm count and action owner.",
    rules: [
      "Exception type is identified (no show, late, security absence, new joiner, manpower gap, other).",
      "Count is extracted when available.",
      "Action owner is identified when available.",
      "Review-only: never auto-decide discipline outcomes."
    ],
    schedule: {
      schedule_kind: "event_driven",
      due_time: "23:59",
      reminder_times: [],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Follow up: workforce exception still needs closure.",
      followup_template: "Workforce exception still open for {date}.",
      overdue_template: null
    }
  },
  {
    slug: "ticket-closure",
    name: "Ticket/action closure",
    category: "closure",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "TT/ticket raised, reconciliation, shortage/damage closure or other management action.",
    feedback_hint: "Closure update noted. Link it to the open action or mark unmatched for review.",
    rules: [
      "Ticket/TT reference or closure description is present.",
      "Link to an open action when a matching reference or clear description exists.",
      "Otherwise mark as unmatched closure for review.",
      "Never invent ticket numbers."
    ],
    schedule: {
      schedule_kind: "event_driven",
      due_time: "23:59",
      reminder_times: [],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "Please confirm closure evidence for open tickets.",
      followup_template: "Closure confirmation still pending for {date}.",
      overdue_template: null
    }
  }
];

export function tcc3TemplateBySlug(slug: string) {
  return TCC3_REPORT_TEMPLATES.find((item) => item.slug === slug) ?? null;
}
