import "regenerator-runtime/runtime";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import type { AuditScoreSnapshot } from "./station-audit-scoring";
export type AuditReportData = {
  number: string;
  station: string;
  type: string;
  auditor: string;
  completed: string;
  status: string;
  summary: string;
  stationResponse: string;
  expectedCash: number | null;
  actualCash: number | null;
  missing: number;
  excess: number;
  cashCounts?: { denomination: number; count: number; amount: number }[];
  snapshot?: AuditScoreSnapshot | null;
  checks: {
    id: string;
    section: string;
    label: string;
    outcome: string;
    remarks: string;
    employees: string;
    nonCompliant?: boolean;
  }[];
  shipments: {
    tid: string;
    discrepancy: string;
    remarks: string;
    response: string;
  }[];
  actions: {
    title: string;
    status: string;
    action: string;
    owner?: string;
    dueAt?: string | null;
    severity?: string;
    completionNote?: string;
  }[];
  photos: {
    id: string;
    label: string;
    image?: Uint8Array;
    unavailable?: boolean;
  }[];
};
const ascii = (s: unknown) =>
  String(s ?? "")
    .replace(/₹/g, "Rs. ")
    .replace(/[–—→·−]/g, " - ")
    .replace(/[\u0000-\u0008\u000B-\u001F]/g, "");
export async function renderAuditPdf(data: AuditReportData) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${data.station} - ${data.type} - ${data.number}`);
  doc.registerFontkit(fontkit);
  const scriptFont = (s: string) =>
    /[\u0D00-\u0D7F]/.test(s)
      ? "NotoSansMalayalam"
      : /[\u0C00-\u0C7F]/.test(s)
        ? "NotoSansTelugu"
        : /[\u0900-\u097F]/.test(s)
          ? "NotoSansDevanagari"
          : /[\u0B80-\u0BFF]/.test(s)
            ? "NotoSansTamil"
            : /[\u0C80-\u0CFF]/.test(s)
              ? "NotoSansKannada"
              : "NotoSans";
  const names = new Set(["NotoSans"]);
  for (const ch of JSON.stringify(data)) names.add(scriptFont(ch));
  const fonts = new Map<string, PDFFont>();
  for (const name of names)
    fonts.set(
      name,
      await doc.embedFont(
        await readFile(
          path.join(
            process.cwd(),
            "assets/report-fonts",
            `${name}-Regular.ttf`,
          ),
        ),
        { subset: true },
      ),
    );
  const font = fonts.get("NotoSans")!,
    bold = font;
  const supported = new Map(
    [...fonts.values()].map((f) => [f, new Set(f.getCharacterSet())]),
  );
  const runs = (value: string) => {
    const rows: { text: string; font: PDFFont }[] = [];
    for (const ch of value) {
      const f = fonts.get(scriptFont(ch)) || font;
      if (!supported.get(f)!.has(ch.codePointAt(0)!))
        throw new Error(
          "Report text contains an unsupported character. Review the full original text in OpsPulse.",
        );
      const last = rows.at(-1);
      if (last?.font === f) last.text += ch;
      else rows.push({ text: ch, font: f });
    }
    return rows;
  };
  const width = (s: string, size: number) =>
    runs(s).reduce((n, r) => n + r.font.widthOfTextAtSize(r.text, size), 0);
  const draw = (s: string, size: number, color: ReturnType<typeof rgb>) => {
    let x = 42;
    for (const r of runs(s)) {
      page.drawText(r.text, { x, y, size, font: r.font, color });
      x += r.font.widthOfTextAtSize(r.text, size);
    }
  };
  const navy = rgb(0.07, 0.16, 0.27),
    teal = rgb(0.05, 0.47, 0.46),
    gray = rgb(0.38, 0.44, 0.53),
    pale = rgb(0.94, 0.97, 0.98);
  let page = doc.addPage([595, 842]),
    y = 800;
  const newPage = () => {
    page = doc.addPage([595, 842]);
    y = 800;
  };
  const ensure = (h: number) => {
    if (y - h < 48) newPage();
  };
  function text(value: unknown, size = 10, strong = false, color = navy) {
    const f = strong ? bold : font,
      words = ascii(value).split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate, size) > 500 && line) {
        ensure(size + 7);
        draw(line, size, color);
        y -= size + 7;
        line = word;
      } else line = candidate;
      // Long tracking IDs and URLs must wrap too.
      while (width(line, size) > 500) {
        let n = line.length;
        while (n > 1 && width(line.slice(0, n), size) > 500) n--;
        ensure(size + 7);
        draw(line.slice(0, n), size, color);
        y -= size + 7;
        line = line.slice(n);
      }
    }
    if (line) {
      ensure(size + 7);
      draw(line, size, color);
      y -= size + 7;
    }
  }
  function heading(label: string) {
    ensure(65);
    y -= 12;
    page.drawRectangle({
      x: 32,
      y: y - 13,
      width: 531,
      height: 31,
      color: pale,
    });
    text(label, 13, true, teal);
    y -= 14;
  }
  page.drawRectangle({ x: 0, y: 677, width: 595, height: 165, color: navy });
  text("DROPX / OPSPULSE", 11, true, rgb(0.4, 0.85, 0.8));
  y -= 9;
  text(data.type, 24, true, rgb(1, 1, 1));
  text(data.station, 14, true, rgb(1, 1, 1));
  text(data.number, 10, false, rgb(0.8, 0.85, 0.9));
  y = 650;
  text(`Auditor: ${data.auditor} | Submitted: ${data.completed}`, 10);
  text(`Status: ${data.status}`, 10);
  text(data.summary || "No summary provided.", 10);
  const s = data.snapshot;
  if (s) {
    heading(
      `${s.percentage ?? "-"}% - ${s.rating}${s.provisional ? " | PROVISIONAL" : ""}`,
    );
    text(
      s.provisional
        ? "Responsibility / scoring review is pending. Do not use this as a final appraisal or R&R score."
        : "Assessed result. Open findings and corrective actions must still be resolved.",
      10,
      false,
      gray,
    );
    text(s.rules.formula, 9, false, gray);
    for (const a of s.sections) {
      ensure(36);
      text(
        `${a.name} | Weight ${a.weight}% | Score ${a.percentage ?? "N/A"}${a.percentage == null ? "" : "%"} | ${a.contribution} points`,
        10,
        true,
      );
      page.drawRectangle({
        x: 42,
        y: y - 3,
        width: 495,
        height: 5,
        color: pale,
      });
      if (a.percentage)
        page.drawRectangle({
          x: 42,
          y: y - 3,
          width: (495 * a.percentage) / 100,
          height: 5,
          color: teal,
        });
      y -= 19;
    }
  }
  heading("COD and shipment reconciliation");
  text(
    `ERP cash: ${data.expectedCash == null ? "Not recorded" : `Rs. ${data.expectedCash}`} | Counted: ${data.actualCash == null ? "Not recorded" : `Rs. ${data.actualCash}`} | Difference: ${data.expectedCash == null || data.actualCash == null ? "Not recorded" : `Rs. ${Math.round((data.actualCash - data.expectedCash) * 100) / 100}`}`,
  );
  text(`Missing TIDs: ${data.missing} | Excess TIDs: ${data.excess}`);
  for (const row of data.cashCounts || [])
    text(`Rs. ${row.denomination} x ${row.count} = Rs. ${row.amount}`, 9);
  for (const row of data.shipments) {
    text(`${row.tid} - ${row.discrepancy}`, 10, true);
    text(row.remarks, 9);
    text(
      `Station response: ${row.response || "Awaiting investigation"}`,
      9,
      false,
      gray,
    );
  }
  if (s && Object.keys(s.assessments).length) {
    heading("Responsibility decisions");
    for (const [key, a] of Object.entries(s.assessments)) {
      text(`${key} - ${a.label}`, 10, true);
      text(
        `${a.pending ? "Pending attribution" : a.excluded ? "Excluded from scoring" : "Included in accuracy calculation"}: ${a.reason || "Investigation pending"}`,
        9,
      );
      if (a.evidenceId)
        text(`Evidence reference: ${a.evidenceId}`, 8, false, gray);
    }
  }
  const sections =
    s?.sections ||
    [...new Set(data.checks.map((c) => c.section))].map((name) => ({
      id: name,
      name,
      weight: 0,
      percentage: null,
      items: [],
    }));
  for (const section of sections) {
    ensure(145);
    heading(
      `${section.name}${s ? ` - ${section.percentage ?? "N/A"}${section.percentage == null ? "" : "%"} / weight ${section.weight}%` : ""}`,
    );
    const scored = section.items;
    for (const c of data.checks.filter(
      (c) => c.section === section.name || scored.some((i) => i.id === c.id),
    )) {
      ensure(90);
      text(c.label, 11, true);
      const score = scored.find((i) => i.id === c.id);
      text(
        `${c.outcome}${score ? ` | Score ${score.score ?? "Excluded"} / 100 | Weight ${score.weight}` : ""}`,
        10,
        false,
        teal,
      );
      if (c.remarks) text(`Observation: ${c.remarks}`, 9);
      if (c.employees) text(`Custodian(s): ${c.employees}`, 9);
    }
    for (const item of scored.filter(
      (i) => !data.checks.some((c) => c.id === i.id),
    )) {
      text(item.label, 11, true);
      text(
        `${item.outcome} | Score ${item.score ?? "Excluded"} / 100`,
        10,
        false,
        teal,
      );
      text(item.reason, 9, false, gray);
    }
  }
  heading("Station response & corrective actions");
  text(data.stationResponse || "No station response recorded.");
  for (const a of data.actions) {
    text(`${a.title} - ${a.status}`, 10, true);
    text(a.action, 9);
  }
  if (s?.inputs) {
    heading("Reconciliation source lists");
    text(
      "Unique tracking IDs saved with this audit; duplicates count once.",
      9,
      false,
      gray,
    );
    text(
      `ERP ageing list - ${new Set(s.inputs.expectedTids).size} TIDs`,
      11,
      true,
    );
    text(
      [...new Set(s.inputs.expectedTids)].join(" | ") || "No TIDs recorded.",
      8,
    );
    text(
      `Physically scanned - ${new Set(s.inputs.scannedTids).size} TIDs`,
      11,
      true,
    );
    text(
      [...new Set(s.inputs.scannedTids)].join(" | ") || "No TIDs recorded.",
      8,
    );
  }
  if (data.photos.length) {
    heading("Evidence gallery - actual submitted evidence");
    for (const p of data.photos) {
      if (p.image) {
        try {
          const img = await doc.embedJpg(p.image);
          const scale = Math.min(495 / img.width, 260 / img.height);
          const w = img.width * scale,
            h = img.height * scale;
          ensure(h + 65);
          text(p.label, 10, true);
          text(`Evidence ${p.id}`, 8, false, gray);
          page.drawImage(img, { x: 42, y: y - h, width: w, height: h });
          y -= h + 18;
        } catch {
          text(
            `${p.label}: image preview unavailable. View the original evidence in OpsPulse.`,
            9,
          );
        }
      } else {
        text(
          `${p.label} - ${p.unavailable ? "preview unavailable" : "document / original available in OpsPulse"} (evidence ${p.id})`,
          9,
        );
      }
    }
  }
  ensure(60);
  text("Review & respond in OpsPulse", 11, true, teal);
  text(`https://ops.dropxlogistics.com/audits`, 10, false, teal);
  text(
    "Open OpsPulse to respond and view the original evidence at full resolution.",
    8,
    false,
    gray,
  );
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(ascii(`${data.number} | ${i + 1} / ${pages.length}`), {
      x: 42,
      y: 24,
      size: 8,
      font,
      color: gray,
    });
  });
  return Buffer.from(await doc.save());
}
