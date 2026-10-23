/** Shared shapes for shift / store checklist report-pack JSON + client PDF. */

export type ReportPackProof = {
  id: string;
  task_id: string;
  content_type: string;
  file_name: string;
  url: string;
};

export type ReportPackTask = {
  id: string;
  label: string;
  answerType: string;
  outcome: string;
  numbers: Record<string, string>;
  lines: Array<Record<string, string>>;
  text: string;
  informed: string;
};

export type ReportPackSection = {
  id: string;
  name: string;
  tasks: ReportPackTask[];
};

export type ReportPack = {
  kind: "shift" | "store";
  editUrl: string;
  checklist: {
    id: string;
    store_code: string;
    store_name: string;
    shift_date?: string;
    shift_slot?: string;
    work_date?: string;
    status: string;
    statusLabel: string;
    person_name: string;
    incoming_name?: string | null;
    started_at: string;
    updated_at: string;
    submitted_at: string | null;
    accepted_at?: string | null;
    answered: number;
    total: number;
    pct: number;
  };
  sections: ReportPackSection[];
  proofs: ReportPackProof[];
};

export function isImageProof(contentType: string, fileName: string) {
  const t = (contentType || "").toLowerCase();
  if (t.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(fileName || "");
}

export function isPdfProof(contentType: string, fileName: string) {
  const t = (contentType || "").toLowerCase();
  return t === "application/pdf" || /\.pdf$/i.test(fileName || "");
}

export function isVideoProof(contentType: string, fileName: string) {
  const t = (contentType || "").toLowerCase();
  if (t.startsWith("video/")) return true;
  return /\.(mp4|webm|mov|m4v)$/i.test(fileName || "");
}

export function formatTaskAnswer(task: ReportPackTask) {
  const bits: string[] = [];
  if (task.outcome) bits.push(task.outcome.toUpperCase());
  const nums = Object.entries(task.numbers || {}).filter(([, v]) => String(v || "").trim());
  if (nums.length) {
    bits.push(nums.map(([k, v]) => `${k}: ${v}`).join(", "));
  }
  if (task.text?.trim()) bits.push(task.text.trim());
  if (task.informed?.trim()) bits.push(`Informed: ${task.informed.trim()}`);
  if (task.lines?.length) {
    bits.push(
      `${task.lines.length} line${task.lines.length === 1 ? "" : "s"}: ` +
        task.lines
          .slice(0, 8)
          .map((line) =>
            Object.entries(line)
              .filter(([, v]) => String(v || "").trim())
              .map(([k, v]) => `${k}=${v}`)
              .join("/"),
          )
          .join(" · "),
    );
  }
  return bits.length ? bits.join(" · ") : "—";
}
