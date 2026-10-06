import type { LivePnl } from "./pnl-data";
import { pnlTotal } from "./pnl";
import { comparisonSelection, comparisonTitle, comparisonViews, comparisonFocuses, pnlResultLabel, stationGroupKey, type ComparisonOptions } from "./pnl-comparison";
import { csvText } from "./pricing";

type Cell = string | number | null;
export function pnlExportData(report: LivePnl, options: ComparisonOptions) {
  const selection = comparisonSelection(report, options);
  const { entries, days, total } = selection;
  const keys = new Set(days.map(d => `${d.station}/${d.date}`));
  const members = new Set(days.map(d => d.station));
  const locations = new Map(report.locations.map(l => [l.station_code, l]));
  const summaryHeader = ["Group", "Included stations", "Delivered", "Revenue INR", "Expenses INR", "Profit / loss INR", "Result", "CPS INR", "Margin %", "Earliest station cutoff", "Latest station cutoff", "Reported station-days", "Expected station-days", "Station-days needing review"];
  const comparison: Cell[][] = [summaryHeader, ...entries.map(r => [comparisonTitle(r.key, options.view), r.members.join(", "), r.deliveries, r.revenue, r.cost, r.profit, pnlResultLabel(r.profit), r.cps, r.margin, r.earliestThrough, r.dataThrough, r.shipmentDays, r.stationDays, r.issueDays])];
  comparison.push(["Shown results", [...members].sort().join(", "), total.deliveries, total.revenue, total.cost, total.profit, pnlResultLabel(total.profit), total.cps, total.margin, null, total.dataThrough, total.shipmentDays, total.stationDays, total.issueDays]);
  const stationDays: Cell[][] = [["Parent group", "Station", "Date", "Delivered", "Revenue INR", "Expenses INR", "Profit / loss INR", "CPS INR", "MG / fixed INR", "XPT payouts INR", "Variable INR", "SWA INR", "MFN INR", "DA INR", "UTR INR", "Van INR", "Rent INR", "Other INR", "Issues"], ...days.map(d => {
    const t = pnlTotal([d]), location = locations.get(d.station);
    return [location ? stationGroupKey(location) : d.station, d.station, d.date, d.deliveries, d.revenue, d.cost, t.profit, t.cps, location?.pricing_model === "xpt" ? null : d.base, location?.pricing_model === "xpt" ? d.base : null, d.variable, d.swa, d.mfn, d.da, d.utr, d.van, d.rent, d.other, d.issues.join("; ")];
  })];
  const sourceCosts: Cell[][] = [["Station", "Date", "Head", "Item", "Source", "Amount INR"], ...report.costs.filter(c => keys.has(`${c.station_code}/${c.work_date}`)).map(c => [c.station_code, c.work_date, c.head, c.sub_head, c.source, c.amount])];
  // Include a review only when its station AND date interval intersect this view.
  const reviews: Cell[][] = [["Station", "Issue", "ID / reference", "From", "Through", "Deliveries", "Action"], ...report.reviews.filter(r => days.some(d => d.station === r.station && d.date >= r.from && d.date <= r.to)).map(r => [r.station, r.kind, r.reference, r.from, r.to, r.deliveries, r.href])];
  const metadata: Cell[][] = [
    ["DropX Finance", "Profit & loss - operating estimate"], ["Requested from", report.filters.from], ["Requested through", report.filters.to],
    ["View", comparisonViews[options.view]], ["Result filter", comparisonFocuses[options.focus]], ["Search", options.search || "None"], ["Sort", `${options.sort} ${options.direction}`],
    ["Client", report.filters.provider || "All permitted"], ["Region", report.filters.region || "All permitted"], ["Cluster", report.filters.cluster || "All permitted"], ["Station", report.filters.location || "All permitted"],
    ["Source read at", report.readAt], ["Export generated at", new Date().toISOString()],
    ["Scope", "All matching rows across all pages. Supporting sheets contain only those station-dates. Parent groups include authorized XPTs once."],
    ["Calculation", "Revenue and expenses stop at each station's delivered-data cutoff. Monthly fixed amounts use actual calendar days. CPS = expenses / delivered; margin = profit / revenue."],
    ["Missing data", "Blank values are unavailable, never zero. Known amounts are included in provisional totals. A group can be partial when one member has missing inputs; review station-days."],
    ["Exclusions", "Before final settlements, unconfigured IHS/SMD adjustments, chargebacks, tax and unallocated corporate costs. SWA matching delivery rates remain provisional."],
    ["Source refresh", "This export is recalculated at download time. Refresh the page if source data changed."],
  ];
  return { ...selection, comparison, sheets: { Comparison: comparison, "Station days": stationDays, "Source costs": sourceCosts, "Items to review": reviews, "Report notes": metadata } };
}
export function exportPnlCsv(report: LivePnl, options: ComparisonOptions) {
  const data = pnlExportData(report, options);
  return csvText([...data.sheets["Report notes"], [], ...data.comparison]);
}
export async function exportPnlExcel(report: LivePnl, options: ComparisonOptions) {
  const XLSX = await import("xlsx");
  const data = pnlExportData(report, options), workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(data.sheets)) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = rows[0].map((label, i) => ({ wch: name === "Report notes" ? i === 0 ? 24 : 110 : /Issues|Item|Source|Included|reference|Action/.test(String(label)) ? 34 : /Group|Station|cutoff/.test(String(label)) ? 23 : 20 }));
    if (name !== "Report notes") {
      sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - (name === "Comparison" ? 2 : 1), c: rows[0].length - 1 } }) };
      for (let r = 1; r < rows.length; r++) for (let c = 0; c < rows[0].length; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell?.t === "n") cell.z = /INR|Margin/.test(String(rows[0][c])) ? '#,##0.00;[Red](#,##0.00);0.00' : '#,##0';
      }
    }
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  workbook.Props = { Title: "DropX Finance - Profit & loss", Subject: `${report.filters.from} to ${report.filters.to}`, Author: "DropX Finance" };
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
export async function exportPnlPdf(report: LivePnl, options: ComparisonOptions) {
  const [{ PDFDocument, rgb }, { default: fontkit }, { readFile }, path] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit"), import("node:fs/promises"), import("node:path")]);
  const data = pnlExportData(report, options), doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await readFile(path.join(process.cwd(), "assets/report-fonts/NotoSans-Regular.ttf")), { subset: true });
  const ink = rgb(.06,.18,.23), teal = rgb(.04,.45,.39), muted = rgb(.36,.43,.48), red = rgb(.7,.17,.21), pale = rgb(.94,.97,.97), white = rgb(1,1,1);
  const cash = (n: number | null) => n === null ? "Unavailable" : n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  let page = doc.addPage([842,595]), y = 555;
  const clean = (value: unknown) => String(value ?? "").replace(/[\r\n\t]/g, " ");
  function wrap(value: unknown, max: number, size: number) {
    const lines: string[] = []; let line = "";
    for (const char of clean(value)) {
      if (font.widthOfTextAtSize(line + char, size) > max && line) { lines.push(line); line = ""; }
      line += char;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  function text(value: unknown, x: number, at: number, size = 9, color = ink, max = 760) {
    const lines = wrap(value, max, size);
    for (const [i, line] of lines.entries()) page.drawText(line, { x, y: at - i * (size + 4), size, color, font });
    return lines.length * (size + 4);
  }
  function header() {
    page.drawRectangle({ x: 0, y: 516, width: 842, height: 79, color: ink });
    text("DROPX / FINANCE", 32, 566, 9, rgb(.48,.85,.75));
    text("Profit & loss", 32, 537, 22, white);
    text(`${report.filters.from} to ${report.filters.to} | ${comparisonViews[options.view]} | INR`, 390, 549, 10, white, 415);
    y = 492;
  }
  const widths = [172,74,96,96,106,66,60,108], xs = widths.map((_, i) => 32 + widths.slice(0,i).reduce((a,b) => a+b,0));
  function tableHeader() {
    page.drawRectangle({ x: 32, y: y - 10, width: 778, height: 28, color: ink });
    ["Group / included XPTs", "Delivered", "Revenue", "Expenses", "Profit / loss", "CPS", "Margin", "Data through"].forEach((s,i) => text(s,xs[i]+6,y,8,white,widths[i]-12));
    y -= 27;
  }
  function nextPage() { page = doc.addPage([842,595]); header(); tableHeader(); }
  header();
  const cards = [["REVENUE", data.total.revenue], ["EXPENSES", data.total.cost], [pnlResultLabel(data.total.profit).toUpperCase(), data.total.profit]] as const;
  cards.forEach(([label,value],i) => { page.drawRectangle({ x:32+i*263,y:424,width:252,height:75,color:pale }); text(label,44+i*263,479,9,muted); text(cash(value),44+i*263,447,21,i===2&&value!==null&&value<0?red:ink,228); });
  y = 403;
  y -= text(`${comparisonFocuses[options.focus]} | ${data.entries.length} matching rows | Sort: ${options.sort} ${options.direction}${options.search ? ` | Search: ${options.search}` : ""}`,32,y,9,muted);
  y -= text(`Scope: ${[report.filters.location || "All permitted station groups",report.filters.region,report.filters.cluster,report.filters.provider].filter(Boolean).join(" / ")}. Provisional operating estimate; missing inputs are not zero.`,32,y,9,muted);
  y -= text("EDSP and XPT are combined once. Each station uses its own delivery-data cutoff for both revenue and cost.",32,y,9,muted);
  y -= 12; tableHeader();
  const rows = [...data.entries, { ...data.total, subtitle: "All matching rows, all pages", earliestThrough: null, missingMembers: 0, key: "Shown results" }];
  for (const [index,row] of rows.entries()) {
    const title = index < data.entries.length ? comparisonTitle(row.key, options.view) : row.key;
    const first = `${title}${row.subtitle ? `\n${row.subtitle}` : ""}`;
    const cutoffs = row.earliestThrough && row.earliestThrough !== row.dataThrough ? `${row.earliestThrough} to ${row.dataThrough}` : row.dataThrough || "Unavailable";
    const values = [first, row.deliveries?.toLocaleString("en-IN") ?? "—", cash(row.revenue), cash(row.cost), row.profit === null ? "Unavailable" : `${row.profit<0?"Loss":row.profit>0?"Profit":"Break-even"} ${cash(Math.abs(row.profit))}`, row.cps === null?"—":row.cps.toFixed(2), row.margin === null?"—":`${row.margin.toFixed(1)}%`, `${cutoffs}${row.issueDays ? " · Review" : ""}${row.missingMembers ? ` · ${row.missingMembers} without data` : ""}`];
    const height = Math.max(37,...values.map((s,i)=>wrap(s,widths[i]-12,8).length*12+15));
    if (y - height < 58) nextPage();
    if (index % 2 === 0 || index === data.entries.length) page.drawRectangle({x:32,y:y-height+8,width:778,height,color:pale});
    values.forEach((value,i) => text(value,xs[i]+6,y-5,8,i===4&&row.profit!==null?(row.profit<0?red:teal):ink,widths[i]-12));
    y -= height;
  }
  for (const [index,p] of doc.getPages().entries()) {
    page=p;
    text(`DropX Finance | ${new Date(report.readAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST | ${index+1} / ${doc.getPageCount()}`,32,30,8,muted);
    text("Before final settlements, tax and unallocated HO costs. Excel includes source costs and review details.",32,17,7,muted);
  }
  doc.setTitle(`DropX P&L ${report.filters.from} to ${report.filters.to}`); doc.setAuthor("DropX Finance");
  return Buffer.from(await doc.save());
}
