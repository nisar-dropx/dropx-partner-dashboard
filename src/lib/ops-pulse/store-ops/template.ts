/** Spec v1 — Store Manager / Store In-charge daily checklist (Amazon Now). */
import type { Template } from "./model";
import type { ProofRule } from "@/lib/ops-pulse/si-handover/model";

type TaskSeed = {
  id: string;
  label: string;
  frequency: import("./model").TaskFrequency;
  when: import("./model").TaskWhen;
  answerType: import("./model").AnswerType;
  numberFields?: { key: string; label: string; options?: readonly string[]; placeholder?: string }[];
  proof: ProofRule;
  noRequires?: import("./model").NoRequires;
  mandatory: import("./model").MandatoryRule;
  linksTo?: string;
  guidance?: string;
};

const none = (): ProofRule => ({ kind: "none", min: 0, max: 0 });
const shot = (min = 1, max = 3): ProofRule => ({ kind: "screenshot", min, max });
const photo = (min = 1, max = 4): ProofRule => ({ kind: "photo", min, max });
const docs = (min = 1, max = 6): ProofRule => ({ kind: "document", min, max });
const optional = (): ProofRule => ({ kind: "optional", min: 0, max: 4 });

const sections: {
  id: string;
  name: string;
  guidance: string;
  tasks: TaskSeed[];
}[] = [
  {
    id: "A",
    name: "Start of my shift",
    guidance: "Complete in the first 2 hours of your shift.",
    tasks: [
      {
        id: "M1",
        label:
          "Shift Incharge checklists for the last 3 shifts reviewed; every 'No' followed up",
        frequency: "daily",
        when: "start",
        answerType: "number",
        numberFields: [{ key: "no_still_open", label: "'No' answers still open" }],
        proof: none(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "SI checklist",
      },
      {
        id: "M2",
        label:
          "Late handovers reviewed (incoming Shift Incharge accepted late or rejected items)",
        frequency: "daily",
        when: "start",
        answerType: "number",
        numberFields: [
          { key: "handovers_late", label: "Handovers late" },
          { key: "handovers_rejected", label: "Handovers rejected" },
        ],
        proof: none(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "SI checklist",
      },
      {
        id: "M3",
        label: "Pending ACK: every high-value loss acknowledged within 48 h",
        frequency: "daily",
        when: "start",
        answerType: "number",
        numberFields: [
          { key: "pending", label: "Items pending" },
          { key: "older_48h", label: "Older than 48 h" },
        ],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "ACK compliance",
      },
      {
        id: "M4",
        label: "Picker headcount vs approved checked; releases or hiring actioned",
        frequency: "daily",
        when: "start",
        answerType: "number",
        numberFields: [
          { key: "ft", label: "Full-time" },
          { key: "pt", label: "Part-time" },
          { key: "approved", label: "Approved HC" },
        ],
        proof: none(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Picker HC",
      },
      {
        id: "M5",
        label: "IRT TTs raised by Shift Incharges approved",
        frequency: "daily",
        when: "start",
        answerType: "number",
        numberFields: [{ key: "tts_pending", label: "TTs pending approval" }],
        proof: none(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Loss rate",
      },
    ],
  },
  {
    id: "B",
    name: "After Amazon D-1 reports",
    guidance:
      "After D-1 reports (~3–5 PM). If your shift ends earlier, complete in the first 2 hours of your next shift.",
    tasks: [
      {
        id: "M6",
        label:
          "D-1 store health scorecard & Amazon Now report reviewed; actions shared with Shift Incharges",
        frequency: "daily",
        when: "after_d1",
        answerType: "yes_no",
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "All metrics",
      },
      {
        id: "M7",
        label:
          "Reconciliation backlog: every transshipment reconciled within 24 h; none closed below 95% without Amazon Ops approval",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [
          { key: "open_over_24h", label: "Open > 24 h" },
          { key: "closed_below_95", label: "Closed below 95%" },
        ],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Reconciliation",
      },
      {
        id: "M8",
        label:
          "Loss RCA done if D-1 loss rate was 1.5% or more (damages & shortages)",
        frequency: "when_applicable",
        when: "after_d1",
        answerType: "yes_no_na",
        numberFields: [
          { key: "loss_pct", label: "Loss %" },
          { key: "loss_rs", label: "Loss ₹" },
        ],
        proof: photo(1, 3),
        noRequires: "reason",
        mandatory: "when_applicable",
        linksTo: "Loss rate",
      },
      {
        id: "M9",
        label: "Aged IOL (7+ days) clearance plan; units moved to pickable bins",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [{ key: "aged_iol", label: "Aged IOL units today" }],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "IOL aged 7+",
      },
      {
        id: "M10",
        label: "Slack: SlackBot messages answered for the store",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [
          { key: "received", label: "Received (D-1)" },
          { key: "answered", label: "Answered (D-1)" },
        ],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Slack response",
      },
      {
        id: "M11",
        label: "Count tasks (CC, SBC, SRC) closed within 24 h",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [{ key: "open_over_24h", label: "Tasks open > 24 h" }],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Count compliance",
      },
      {
        id: "M12",
        label:
          "Tote tools pendency zero: Square Off (inbound) & Tracks (empty outbound)",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [{ key: "pending", label: "Pending items" }],
        proof: shot(2, 4),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Tote tools",
      },
      {
        id: "M13",
        label: "Guided removal & expiry tasks completed",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [
          { key: "assigned", label: "Assigned" },
          { key: "completed", label: "Completed" },
        ],
        proof: shot(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "Guided removal",
      },
      {
        id: "M14",
        label: "YMS: every vehicle checked in & out; misses explained",
        frequency: "daily",
        when: "after_d1",
        answerType: "number",
        numberFields: [
          { key: "vehicles", label: "Vehicles" },
          { key: "misses", label: "Misses" },
        ],
        proof: shot(),
        noRequires: "reason",
        mandatory: "hyderabad",
        linksTo: "YMS",
        guidance: "Mandatory for Hyderabad stores.",
      },
    ],
  },
  {
    id: "C",
    name: "Compliance & audits",
    guidance: "Weekly and monthly items stay open until done in the period.",
    tasks: [
      {
        id: "M15",
        label:
          "Disposal verified before submission: goods destroyed, biodegradable bags, manifest signed & stamped by vendor, photos fresh & distinct",
        frequency: "when_disposal",
        when: "compliance",
        answerType: "yes_no_na",
        numberFields: [{ key: "units_disposed", label: "Units disposed" }],
        proof: docs(2, 6),
        noRequires: "reason",
        mandatory: "if_disposal",
        linksTo: "CLEAR audit",
      },
      {
        id: "M16",
        label: "Apollo readiness walk using the Apollo audit readiness checklist",
        frequency: "weekly",
        when: "compliance",
        answerType: "yes_no",
        numberFields: [{ key: "gaps_found", label: "Gaps found" }],
        proof: photo(1, 3),
        noRequires: "reason",
        mandatory: "weekly",
        linksTo: "Apollo audit",
        guidance: "Once per Mon–Sun week.",
      },
      {
        id: "M17",
        label:
          "Statutory documents valid & displayed: trade licence, GST APOB, pest control, CLRA, escalation matrix, emergency contacts",
        frequency: "monthly",
        when: "compliance",
        answerType: "yes_no",
        numberFields: [
          { key: "expiring_30d", label: "Documents expiring in 30 days" },
        ],
        proof: photo(1, 4),
        noRequires: "reason",
        mandatory: "monthly",
        linksTo: "Apollo audit",
        guidance: "Due by the 3rd of each month.",
      },
      {
        id: "M18",
        label: "IRDR & ERMR report submitted",
        frequency: "monthly",
        when: "compliance",
        answerType: "yes_no",
        numberFields: [{ key: "report_pct", label: "Report %" }],
        proof: shot(),
        noRequires: "reason",
        mandatory: "monthly",
        linksTo: "IRDR & ERMR",
        guidance: "As per Amazon monthly cadence.",
      },
    ],
  },
  {
    id: "D",
    name: "Day close",
    guidance: "Submit once at end of your shift — no acceptance step.",
    tasks: [
      {
        id: "M19",
        label:
          "Day summary to City Manager: top 3 issues, escalations, help needed",
        frequency: "daily",
        when: "close",
        answerType: "text",
        proof: optional(),
        noRequires: "reason",
        mandatory: "yes",
        linksTo: "All",
        guidance: "Free text: top issues, escalations, help needed.",
      },
    ],
  },
];

export function defaultStoreOpsTemplate(): Template {
  return {
    name: "Ops Pulse · Store Operations",
    description:
      "One checklist per store per day for Store Manager / Store In-charge. Submit seals the day — no accept or reject.",
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      guidance: s.guidance,
      tasks: s.tasks.map((t) => ({
        id: t.id,
        label: t.label,
        guidance: t.guidance ?? "",
        frequency: t.frequency,
        when: t.when,
        answerType: t.answerType,
        numberFields: (t.numberFields ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          ...(f.options?.length ? { options: [...f.options] } : {}),
          ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        })),
        proof: t.proof,
        noRequires: t.noRequires ?? "reason",
        mandatory: t.mandatory,
        linksTo: t.linksTo ?? "",
      })),
    })),
  };
}
