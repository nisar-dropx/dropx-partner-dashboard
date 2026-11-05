/**
 * Last Mile Report Bot catalog: Station board + EOD screenshots.
 * Installed per company via an explicit action — never auto-applied to a live group.
 */

export type LastMileTemplate = {
  slug: string;
  name: string;
  category: string;
  auto_reply_policy: "never" | "normal";
  subtypes: string[];
  description: string;
  feedback_hint: string;
  rules: string[];
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

/** Hourly reminder slots 09:00–21:00 inclusive (matches intervalTimes("09:00","21:00",60)). */
export const LAST_MILE_HOURLY_REMINDERS = [
  "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"
];

function hourlyBoardSchedule(reportLabel: string): NonNullable<LastMileTemplate["schedule"]> {
  return {
    schedule_kind: "interval",
    due_time: "21:00",
    reminder_times: LAST_MILE_HOURLY_REMINDERS,
    stop_when_received: false,
    review_only: true,
    first_reminder_template: `{group}: please share the *{report}* (${reportLabel}) screenshot for {date}.`,
    followup_template: `Hourly *{report}* still pending for this slot ({date}).`,
    overdue_template: null
  };
}

function boardRules(boardName: string, extras: string[] = []): string[] {
  return [
    `Screenshot is clearly the Ops Pulse Station board ${boardName} view.`,
    "Business date on the board is today (or the date stated in the caption).",
    "Station codes / names in the screenshot are legible.",
    "Key totals or percentages on the board are readable, or explicitly marked unavailable.",
    "Never invent station codes, counts or percentages that are not clearly legible.",
    ...extras
  ];
}

export const LAST_MILE_REPORT_TEMPLATES: LastMileTemplate[] = [
  {
    slug: "eod-closure",
    name: "EOD closure screenshot",
    category: "closure",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Screenshot of the station EOD dashboard with closure status.",
    feedback_hint: "EOD closure noted. Resend a clearer shot if date, liability or station code is unreadable.",
    rules: [
      "Date on the screenshot is today",
      "Pending liability shows zero",
      "Station code is visible"
    ],
    schedule: {
      schedule_kind: "timed",
      due_time: "21:00",
      reminder_times: ["20:00", "20:30", "21:00"],
      stop_when_received: true,
      review_only: true,
      first_reminder_template: "{group}: please share today's *{report}* by {due_time}.",
      followup_template: "Reminder: *{report}* for {date} is still pending.",
      overdue_template: "*{report}* for {date} is overdue. Please share the closure screenshot now."
    }
  },
  {
    slug: "station-type-board",
    name: "Station-type board screenshot",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: ["Station", "Associate"],
    description: "Station board opened at Station detail level (not associate drill-down), showing the selected metric for that station type layout.",
    feedback_hint: "Station-type board noted. Resend if station codes or the metric columns are unreadable.",
    rules: boardRules("station-type / station-level", [
      "Detail level is Station (not Associate drill-down), or the caption states the level.",
      "The selected metric tab is visible on the toolbar."
    ]),
    schedule: hourlyBoardSchedule("station-type")
  },
  {
    slug: "station-board-edd",
    name: "Station board · EDD",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Ops Pulse Station board EDD heatmap / pending-by-date screenshot.",
    feedback_hint: "EDD board noted. Resend if date columns or station rows are unreadable.",
    rules: boardRules("EDD", ["EDD date columns or pending totals are present and legible."]),
    schedule: hourlyBoardSchedule("EDD")
  },
  {
    slug: "station-board-ageing",
    name: "Station board · Ageing",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: ["Day", "Week"],
    description: "Ops Pulse Station board Ageing (day buckets or state × week) screenshot.",
    feedback_hint: "Ageing board noted. Resend if ageing buckets or amounts are unreadable.",
    rules: boardRules("Ageing", ["Ageing day or week buckets are present and legible."]),
    schedule: hourlyBoardSchedule("Ageing")
  },
  {
    slug: "station-board-creturn",
    name: "Station board · C-Return",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: ["Station", "Associate"],
    description: "Ops Pulse Station board C-Return pending-pickup screenshot.",
    feedback_hint: "C-Return board noted. Resend if pending pickup totals are unreadable.",
    rules: boardRules("C-Return", ["Pending pickup totals are present and legible."]),
    schedule: hourlyBoardSchedule("C-Return")
  },
  {
    slug: "station-board-dsr",
    name: "Station board · DSR",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: ["Station", "Associate"],
    description: "Ops Pulse Station board DSR (delivery success rate) screenshot.",
    feedback_hint: "DSR board noted. Resend if DSR% or shipment totals are unreadable.",
    rules: boardRules("DSR", ["DSR% and assigned / delivered totals are present and legible."]),
    schedule: hourlyBoardSchedule("DSR")
  },
  {
    slug: "station-board-dot",
    name: "Station board · DOT",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: ["DOT", "Premium", "Standard"],
    description: "Ops Pulse Station board DOT / Premium DOT / Standard DOT screenshot.",
    feedback_hint: "DOT board noted. Resend if DOT% columns are unreadable.",
    rules: boardRules("DOT", ["DOT% (or Premium/Standard) columns are present and legible."]),
    schedule: hourlyBoardSchedule("DOT")
  },
  {
    slug: "station-board-rts",
    name: "Station board · RTS pendency",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Ops Pulse Station board RTS pendency screenshot.",
    feedback_hint: "RTS board noted. Resend if RTS pending totals are unreadable.",
    rules: boardRules("RTS pendency", ["RTS pending totals or statuses are present and legible."]),
    schedule: hourlyBoardSchedule("RTS")
  },
  {
    slug: "station-board-swa",
    name: "Station board · SWA DSR",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Ops Pulse Station board SWA DSR screenshot.",
    feedback_hint: "SWA DSR board noted. Resend if SWA totals are unreadable.",
    rules: boardRules("SWA DSR", ["SWA DSR% and shipment totals are present and legible."]),
    schedule: hourlyBoardSchedule("SWA DSR")
  },
  {
    slug: "station-board-zero",
    name: "Station board · Zero deliveries",
    category: "station_board",
    auto_reply_policy: "normal",
    subtypes: [],
    description: "Ops Pulse Station board Zero deliveries screenshot.",
    feedback_hint: "Zero-deliveries board noted. Resend if zero-delivery rows are unreadable.",
    rules: boardRules("Zero deliveries", ["Zero-delivery associates or stations are visible, or the board shows none."]),
    schedule: hourlyBoardSchedule("Zero deliveries")
  }
];
