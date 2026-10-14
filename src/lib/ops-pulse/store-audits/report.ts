import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  questions,
  score,
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
  return [
    a.store_name,
    a.number,
    `Status: ${statusLabels[a.status]} | Checklist version: ${a.template_version}`,
    `Auditor: ${a.assigned_name}`,
    `Scheduled: ${auditDate(a.scheduled_for)} | Completed: ${auditDate(a.completed_at)}`,
    `Checklist compliance: ${score(a) === null ? "Not scored" : `${score(a)}%`} (applicable answered checks, equal weight)`,
    `Summary: ${a.summary || "Not recorded"}`,
    ...a.template.sections.flatMap((s) => [
      s.name,
      ...s.questions.flatMap((q) => {
        const answer = a.answers[q.id];
        const f = a.findings.find((f) => f.questionId === q.id);
        return [
          `${q.label} — ${answer?.outcome || "Not answered"}`,
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
  ];
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
