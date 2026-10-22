import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  auditTypeLabels,
  questions,
  score,
  scoreBand,
  scoreSnapshot,
  statusLabels,
  type StoreAudit,
  type Proof,
} from "./model";
export const auditDate = (v: string | null) =>
  v
    ? new Date(v).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " IST"
    : "—";
export function reportLines(a: StoreAudit) {
  const snap = a.score_snapshot || scoreSnapshot(a);
  const pct = a.score ?? score(a);
  const band = a.score_band ?? scoreBand(pct);
  return [
    a.store_name,
    a.number,
    `Type: ${auditTypeLabels[a.audit_type || "mock"]} | Status: ${statusLabels[a.status]} | Checklist version: ${a.template_version}`,
    `Auditor: ${a.assigned_name}${a.present_sm_name ? ` | SM/SI present: ${a.present_sm_name}` : ""}`,
    a.audit_type === "amazon"
      ? `Amazon score: ${a.amazon_score ?? "—"}% | Amazon auditor: ${a.amazon_auditor || "—"}`
      : "",
    `Scheduled: ${auditDate(a.scheduled_for)} | Completed: ${auditDate(a.completed_at)}`,
    `DropX score: ${pct === null ? "Not scored" : `${pct}%`} (${band || "n/a"}) — ${snap.formula}`,
    ...snap.sections
      .filter((s) => s.percentage != null)
      .map(
        (s) =>
          `Section ${s.name}: ${s.percentage}% (${s.compliant}/${s.answered} compliant)`,
      ),
    snap.gaps.length
      ? `Top gaps: ${snap.gaps
          .slice(0, 8)
          .map((g) => `${g.id}×${g.instances}`)
          .join(", ")}`
      : "No scored gaps",
    `Summary: ${a.summary || "Not recorded"}`,
    ...a.template.sections.flatMap((s) => [
      s.name,
      ...s.questions.flatMap((q) => {
        const answer = a.answers[q.id];
        const f = a.findings.find((f) => f.questionId === q.id);
        const response =
          answer?.response ||
          (answer?.outcome === "pass"
            ? q.compliantAnswer || "yes"
            : answer?.outcome === "gap"
              ? q.compliantAnswer === "no"
                ? "yes"
                : "no"
              : answer?.outcome) ||
          "Not answered";
        return [
          `${q.id}. ${q.label} — ${response}${answer?.outcome ? ` (${answer.outcome})` : ""}`,
          answer?.instances
            ? `Instances: ${answer.instances}`
            : "",
          answer?.extras && Object.keys(answer.extras).length
            ? `Extra: ${Object.entries(answer.extras)
                .map(([k, v]) => `${k}=${v}`)
                .join("; ")}`
            : "",
          answer?.observation ? `Observation: ${answer.observation}` : "",
          answer?.outcome === "gap"
            ? `Action: ${answer.action} | Owner: ${answer.owner} | Due: ${auditDate(answer.dueAt)}`
            : "",
          f
            ? `Follow-up: ${f.state} | Store response: ${f.note || "Awaiting response"}`
            : "",
          f?.reviewNote ? `Review: ${f.reviewNote}` : "",
        ].filter(Boolean);
      }),
    ]),
  ].filter(Boolean);
}
export async function storeAuditPdf(a: StoreAudit, proof: Proof[]) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${a.store_name} · Store audit`);
  doc.setAuthor("DropX · OpsPulse");
  const font = await doc.embedFont(
    await readFile(
      path.join(process.cwd(), "assets/report-fonts/NotoSans-Regular.ttf"),
    ),
    { subset: true },
  );
  let page = doc.addPage([595, 842]),
    y = 795;
  let pages = 1;
  const line = (text: string, size = 10) => {
    const words = text
      .replace(/[\r\n]+/g, " ")
      .split(/\s+/)
      .flatMap((word) => {
        const chunks: string[] = [];
        let chunk = "";
        for (const char of word) {
          if (chunk && font.widthOfTextAtSize(chunk + char, size) > 515) {
            chunks.push(chunk);
            chunk = "";
          }
          chunk += char;
        }
        if (chunk) chunks.push(chunk);
        return chunks;
      });
    let row = "";
    const draw = (s: string) => {
      if (y < 52) {
        page = doc.addPage([595, 842]);
        pages++;
        y = 795;
      }
      page.drawText(s, { x: 40, y, size, font, color: rgb(0.12, 0.18, 0.28) });
      y -= size + 5;
    };
    for (const word of words) {
      if (font.widthOfTextAtSize(`${row} ${word}`, size) > 515 && row) {
        draw(row);
        row = word;
      } else row = row ? `${row} ${word}` : word;
    }
    if (row) draw(row);
    y -= 5;
  };
  line("DROPX · OPSPULSE / STORE AUDIT", 16);
  for (const text of reportLines(a))
    line(text, a.template.sections.some((s) => s.name === text) ? 13 : 10);
  line("Evidence", 13);
  for (const p of proof)
    line(
      `${questions(a.template).find((q) => q.id === p.question_id)?.label || p.question_id} / ${p.phase}: ${p.file_name}`,
    );
  line("Open the audit in OpsPulse to view protected attachments.");
  line(`https://ops.dropxlogistics.com/store-audits?audit=${a.id}`);
  doc.getPages().forEach((p, i) =>
    p.drawText(`${a.number}  ·  ${i + 1} / ${pages}`, {
      x: 40,
      y: 25,
      size: 8,
      font,
      color: rgb(0.4, 0.45, 0.5),
    }),
  );
  return Buffer.from(await doc.save());
}
