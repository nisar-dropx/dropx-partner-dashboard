/** Spec v1 task catalogue — Shift Incharge checklist for Amazon Now dark stores. */
import { YMS_VEHICLE_TYPES, type Template } from "./model";

type TaskSeed = {
  id: string;
  label: string;
  when: import("./model").TaskWhen;
  answerType: import("./model").AnswerType;
  numberFields?: {
    key: string;
    label: string;
    options?: readonly string[];
    placeholder?: string;
  }[];
  proof: import("./model").ProofRule;
  noRequires?: import("./model").NoRequires;
  mandatory: import("./model").MandatoryRule;
  linksTo?: string;
  guidance?: string;
};

/** Live camera photo or short video (CLEAR-sensitive checks prefer camera). */
const live = (min = 1, max = 5): import("./model").ProofRule => ({
  kind: "live",
  min,
  max,
});
/** Dashboard / portal screenshots only (gallery OK). */
const shot = (min = 1, max = 3): import("./model").ProofRule => ({
  kind: "screenshot",
  min,
  max,
});
/** Photos and/or PDF (stamped manifests). */
const docs = (min = 1, max = 8): import("./model").ProofRule => ({
  kind: "document",
  min,
  max,
});
const none: import("./model").ProofRule = { kind: "none", min: 0, max: 0 };
const optional: import("./model").ProofRule = {
  kind: "optional",
  min: 0,
  max: 3,
};

const sections: { id: string; name: string; guidance: string; tasks: TaskSeed[] }[] =
  [
    {
      id: "A",
      name: "Shift open & people",
      guidance: "Complete at shift start before the floor opens fully.",
      tasks: [
        {
          id: "A1",
          label: "Shift opened; attendance marked (manual sheet & system)",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [
            { key: "pickers_ft", label: "Pickers present · full-time" },
            { key: "pickers_pt", label: "Pickers present · part-time" },
          ],
          proof: live(),
          noRequires: "both",
          mandatory: "yes",
          linksTo: "Picker HC",
          guidance:
            "FT/PT counts auto-fill from punches at this store for the shift. Edit if someone isn’t registered, hasn’t punched, or isn’t coded as a picker. Still attach the attendance-sheet photo.",
        },
        {
          id: "A2",
          label: "Team huddle with pickers on SOP & D-1 performance",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [
            { key: "pickers_attended", label: "No. of pickers attended" },
          ],
          proof: live(),
          noRequires: "reason",
          mandatory: "yes",
        },
        {
          id: "A3",
          label: "Security present",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [{ key: "guards", label: "No. of guards" }],
          proof: none,
          noRequires: "informed",
          mandatory: "yes",
        },
        {
          id: "A4",
          label: "Housekeeping present",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [{ key: "hk_staff", label: "No. of staff" }],
          proof: none,
          noRequires: "informed",
          mandatory: "yes",
        },
        {
          id: "A5",
          label:
            "Rider area checked: rider logins; call-outs flagged to rider in-charge / RM",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [
            { key: "riders_logged_in", label: "Riders logged in" },
          ],
          proof: none,
          noRequires: "informed",
          mandatory: "yes",
        },
      ],
    },
    {
      id: "B",
      name: "Facility & utilities",
      guidance: "",
      tasks: [
        {
          id: "B1",
          label: "Power: EB supply on; DG fuel level checked",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [{ key: "dg_fuel_pct", label: "DG fuel level (%)" }],
          proof: live(),
          noRequires: "both",
          mandatory: "yes",
        },
        {
          id: "B2",
          label: "Internet working",
          when: "shift_start",
          answerType: "yes_no",
          proof: none,
          noRequires: "reason",
          mandatory: "yes",
          guidance: "If No, enter ticket number in reason.",
        },
        {
          id: "B3",
          label: "Water supply: usage & drinking available",
          when: "shift_start",
          answerType: "yes_no",
          proof: none,
          noRequires: "informed",
          mandatory: "yes",
        },
        {
          id: "B4",
          label:
            "Temperatures within range: Ambient, Tropical, Chiller (0 to 5 C), Freezer (-22 to -18 C)",
          when: "shift_start_mid",
          answerType: "number_x4",
          numberFields: [
            { key: "temp_ambient", label: "Ambient (°C)" },
            { key: "temp_tropical", label: "Tropical (°C)" },
            { key: "temp_chiller", label: "Chiller (°C)" },
            { key: "temp_freezer", label: "Freezer (°C)" },
          ],
          proof: live(4, 8),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Apollo audit",
          guidance:
            "Out-of-range readings are flagged. Live photo/video of each meter required.",
        },
        {
          id: "B5",
          label: "HHD devices charged & working",
          when: "shift_start",
          answerType: "number",
          numberFields: [
            { key: "devices_working", label: "Devices working" },
            { key: "devices_total", label: "Devices total" },
          ],
          proof: none,
          noRequires: "reason",
          mandatory: "yes",
          guidance: "If devices are down, list device IDs in reason.",
        },
        {
          id: "B6",
          label: "Paper bags available; raised to Amazon if out of stock",
          when: "shift_start",
          answerType: "yes_no",
          numberFields: [
            { key: "bags_approx", label: "Bags in stock (approx.)" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          guidance: "If OOS, attach screenshot of the request raised.",
        },
      ],
    },
    {
      id: "C",
      name: "Hygiene & 5S",
      guidance: "",
      tasks: [
        {
          id: "C1",
          label: "Floor & restrooms clean",
          when: "shift_start",
          answerType: "yes_no",
          proof: live(2, 4),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Apollo audit",
        },
        {
          id: "C2",
          label:
            "Pick path & all aisles clean; no waste paper, damaged bags or crates blocking",
          when: "shift_start_mid",
          answerType: "yes_no",
          proof: live(2, 4),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Apollo audit",
        },
        {
          id: "C3",
          label: "Parking & store premises clean",
          when: "shift_start",
          answerType: "yes_no",
          proof: live(),
          noRequires: "reason",
          mandatory: "yes",
        },
        {
          id: "C4",
          label: "DEQ / bad-stock area demarcated; dump collection done",
          when: "shift_end",
          answerType: "yes_no",
          proof: live(),
          noRequires: "reason",
          mandatory: "yes",
        },
      ],
    },
    {
      id: "D",
      name: "Inbound & inventory",
      guidance: "",
      tasks: [
        {
          id: "D1",
          label: "Gemba walk done; planogram & category placement verified",
          when: "mid_shift",
          answerType: "yes_no",
          numberFields: [{ key: "issues_found", label: "Issues found" }],
          proof: live(3, 6),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Apollo audit",
          guidance: "Live photos of 3 bays (planogram / category placement).",
        },
        {
          id: "D2",
          label: "Stowing pendency checked in transshipment dashboard",
          when: "mid_shift_end",
          answerType: "number",
          numberFields: [
            { key: "units_pending_mid", label: "Units pending (mid-shift)" },
            { key: "units_pending_end", label: "Units pending (shift end)" },
          ],
          proof: shot(2, 4),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Stowed within SLA",
        },
        {
          id: "D3",
          label:
            "All transshipments received this shift reconciled after full physical count (95%+)",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "ts_open", label: "Transshipments open" },
            { key: "units_not_reconciled", label: "Units not reconciled" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Reconciliation, loss (backlog rule)",
        },
        {
          id: "D4",
          label:
            "IRT portal checked for damage & shortage; TT raised with Store Manager approval; TT tracker updated",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "tts_raised", label: "TTs raised this shift" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Loss rate",
        },
        {
          id: "D5",
          label: "IOL aged 7+ days moved to pickable bins",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "aged_iol", label: "Aged IOL units at shift end" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "IOL aged 7+ days",
        },
        {
          id: "D6",
          label:
            "FEFO / QC on perishables (bread, dairy, eggs, fresh veg) every 2 hrs; photos before 9 AM & 6 PM",
          when: "every_2hrs",
          answerType: "number",
          numberFields: [
            { key: "checks_done", label: "Checks done" },
            { key: "units_removed", label: "Units removed" },
          ],
          proof: live(1, 12),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Apollo audit, shorts",
        },
        {
          id: "D7",
          label: "FIFO random check in non-food zones",
          when: "mid_shift",
          answerType: "yes_no",
          numberFields: [{ key: "issues_found", label: "Issues found" }],
          proof: live(),
          noRequires: "reason",
          mandatory: "yes",
        },
        {
          id: "D8",
          label:
            "HHD auto tasks checked every 2 hrs (OB returns / cancellations, unified CC)",
          when: "every_2hrs",
          answerType: "number",
          numberFields: [
            { key: "tasks_open_end", label: "Tasks open at shift end" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Count compliance",
        },
        {
          id: "D9",
          label:
            "Audit tasks closed in HHD: SBC, BOH, BVC, IRDR, transshipment",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            // Spec order: SBC | BOH | BVC | IRDR | Transshipment (Number × 5)
            { key: "sbc_open", label: "SBC · tasks open" },
            { key: "boh_open", label: "BOH · tasks open" },
            { key: "bvc_open", label: "BVC · tasks open" },
            { key: "irdr_open", label: "IRDR · tasks open" },
            { key: "ts_open", label: "Transshipment · tasks open" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Count compliance, IRDR & ERMR",
          guidance:
            "Separate fields for each queue at shift end. Enter 0 when none are open — do not combine SBC / BOH / BVC. If tasks remain open, give the reason per task type.",
        },
        {
          id: "D10",
          label:
            "Wall-to-wall cycle count done with mentors; stock consolidated per MBQ; tracker updated",
          when: "shift_end",
          answerType: "number",
          numberFields: [{ key: "bins_counted", label: "Bins counted" }],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Count compliance, SBC defect",
        },
        {
          id: "D11",
          label: "Guided removal & expiry tasks completed",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "assigned", label: "Assigned" },
            { key: "completed", label: "Completed" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Guided removal, expiry awareness",
        },
      ],
    },
    {
      id: "E",
      name: "Outbound, tools & disposal",
      guidance: "",
      tasks: [
        {
          id: "E1",
          label: "OB INF RCA updated",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "inf_orders", label: "INF orders" },
            { key: "rcas_updated", label: "RCAs updated" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Shorts",
        },
        {
          id: "E2",
          label:
            "Tote tools updated: Square Off (inbound) & Tracks (empty outbound)",
          when: "shift_end",
          answerType: "yes_no",
          proof: shot(2, 4),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Tote tools",
        },
        {
          id: "E3",
          label: "YMS: every vehicle checked in & out",
          when: "each_vehicle",
          answerType: "line_items",
          numberFields: [
            {
              key: "vehicle_no",
              label: "Vehicle no",
              placeholder: "Reg. / YMS id",
            },
            {
              key: "vehicle_type",
              label: "Type",
              options: YMS_VEHICLE_TYPES,
            },
            {
              key: "checked_in",
              label: "Checked in",
              placeholder: "HH:MM or Yes",
            },
            {
              key: "checked_out",
              label: "Checked out",
              placeholder: "HH:MM or Yes",
            },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "hyderabad",
          linksTo: "YMS",
          guidance:
            "Mandatory for Hyderabad stores. One line per vehicle (Ambient / Tropical / Chiller / Freezer / Multi-temp). Use + Add vehicle for each arrival; enter vehicle no. + reason if any miss check-in or check-out.",
        },
        {
          id: "E4",
          label:
            "Disposal (if done this shift): goods destroyed, waste in biodegradable bags, manifest signed & stamped by vendor",
          when: "when_disposal",
          answerType: "yes_no_na",
          numberFields: [{ key: "units_disposed", label: "Units disposed" }],
          // Spec: live photos (min 3, no gallery) + photo/PDF of stamped manifest.
          // document kind accepts camera photos + PDF; Take/Live preferred in UI for images.
          proof: docs(3, 8),
          noRequires: "reason",
          mandatory: "if_disposal",
          linksTo: "CLEAR audit",
          guidance:
            "Use N/A when no disposal this shift. Upload ≥3 live photos of goods destroyed / bagged waste, plus photo or PDF of the vendor-stamped manifest. Do not dispatch if incomplete — inform Store Manager.",
        },
        {
          id: "E5",
          label: "SlackBot messages answered",
          when: "shift_end",
          answerType: "number",
          numberFields: [
            { key: "received", label: "Received" },
            { key: "answered", label: "Answered" },
          ],
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
          linksTo: "Slack response",
        },
      ],
    },
    {
      id: "F",
      name: "Handover",
      guidance: "Complete before submitting to the incoming Shift Incharge.",
      tasks: [
        {
          id: "F1",
          label: "Handover message posted to team group; open issues listed",
          when: "shift_end",
          answerType: "yes_no",
          proof: shot(),
          noRequires: "reason",
          mandatory: "yes",
        },
        {
          id: "F2",
          label: "Open issues for incoming Shift Incharge",
          when: "shift_end",
          answerType: "text",
          proof: optional,
          noRequires: "reason",
          mandatory: "yes",
          guidance: "Free text: each issue + owner.",
        },
      ],
    },
  ];

export function defaultSiTemplate(): Template {
  return {
    name: "Ops Pulse · Shift Incharge Task List & Handover",
    description:
      "One checklist per store per shift (6 AM, 2 PM, 10 PM). Spec v1 — live camera capture with time & GPS stamp unless stated; screenshots for dashboards only. Outgoing SI completes & submits; incoming SI accepts before outgoing closes the shift.",
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      guidance: s.guidance,
      tasks: s.tasks.map((t) => ({
        id: t.id,
        label: t.label,
        guidance: t.guidance ?? "",
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
