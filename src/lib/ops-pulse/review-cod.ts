export type ReviewCodLine = {
  rowNumber: number; trackingId: string; orderId: string; associate: string; associateId: string;
  pendingDate: string; bucket: string; status: string; amount: number; overdue: boolean;
};
export type ReviewCodGroup = { label: string; amount: number; lines: number; overdue: boolean };
export type ReviewCodSummary = {
  total: number; overdueAmount: number; tidCount: number; lineCount: number;
  tone: "red" | "green" | "neutral"; buckets: ReviewCodGroup[]; days: ReviewCodGroup[];
};
export type ReviewCodSnapshot = {
  stationCode: string; batchId: string | null; importedAt: string | null; fileName: string | null;
  summary: ReviewCodSummary | null; error: string | null;
};

export type ReviewCodFilters = { bucket?: string; day?: string; associate?: string };
export const codAssociateKey = (line: Pick<ReviewCodLine, "associateId" | "associate">) => JSON.stringify([line.associateId, line.associate]);
export const codDayLabel = (line: Pick<ReviewCodLine, "pendingDate">) => line.pendingDate || "Date not supplied";

// The panel and export apply the same selection to the same station snapshot.
export function filterReviewCod(lines: ReviewCodLine[], filters: ReviewCodFilters): ReviewCodLine[] {
  return lines.filter(line =>
    (filters.bucket === undefined || line.bucket === filters.bucket) &&
    (filters.day === undefined || codDayLabel(line) === filters.day) &&
    (filters.associate === undefined || codAssociateKey(line) === filters.associate));
}

export function codFilterParams(filters: ReviewCodFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["bucket", "day", "associate"] as const) {
    if (filters[key] !== undefined) params.set(key, filters[key]);
  }
  return params;
}

export function readCodFilters(params: URLSearchParams, lines: ReviewCodLine[]): ReviewCodFilters {
  const filters: ReviewCodFilters = {};
  for (const key of ["bucket", "day", "associate"] as const) {
    if (!params.has(key)) continue;
    const values = params.getAll(key);
    if (values.length !== 1 || !values[0] || values[0].length > 1000) throw new Error("Invalid COD filter.");
    filters[key] = values[0];
  }
  if (Object.keys(filters).length && !filterReviewCod(lines, filters).length) throw new Error("This selection is not available in the selected station report.");
  return filters;
}

export function groupReviewCodAssociates(lines: ReviewCodLine[]) {
  const groups = new Map<string, {key:string; name:string; id:string; amount:number; overdueAmount:number; lines:number; tids:Set<string>}>();
  for (const line of lines) {
    const key = codAssociateKey(line);
    const row = groups.get(key) || {key, name:line.associate, id:line.associateId, amount:0, overdueAmount:0, lines:0, tids:new Set<string>()};
    row.amount += Math.round(line.amount * 100);
    if (line.overdue) row.overdueAmount += Math.round(line.amount * 100);
    row.lines++;
    if (line.trackingId) row.tids.add(line.trackingId);
    groups.set(key, row);
  }
  return [...groups.values()].sort((a,b) => b.amount-a.amount || a.key.localeCompare(b.key)).map(({tids,...row}) => ({...row, amount:row.amount/100, overdueAmount:row.overdueAmount/100, tidCount:tids.size}));
}

export function codAgeConcern(bucket: string, pendingDate: string, importedAt: string): boolean {
  // Use Amazon's age bands as supplied; never recalculate a valid band using today's date.
  const band = bucket.trim().match(/^(\d{1,3})(?:\s*[-–]\s*\d{1,3}|\+)?\s*DAYS?$/i);
  if (band) return Number(band[1]) >= 2;
  // Legacy/unknown labels (e.g. a year) stay visible verbatim; dates only determine their alert.
  const importedDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(importedAt));
  const days = (Date.parse(`${importedDay}T00:00:00Z`) - Date.parse(`${pendingDate}T00:00:00Z`)) / 86400000;
  return Number.isFinite(days) && days >= 2;
}

export function parseReviewCodLine(row: {row_number:number;station_code:string|null;raw_data:unknown;normalized_data:unknown}, stationCode: string, importedAt: string): ReviewCodLine | null {
  const raw = row.raw_data && typeof row.raw_data === "object" ? row.raw_data as Record<string,unknown> : {};
  const normalized = row.normalized_data && typeof row.normalized_data === "object" ? row.normalized_data as Record<string,unknown> : {};
  const data = {...raw,...normalized};
  if (row.station_code !== stationCode || (data.station_code && String(data.station_code).trim().toUpperCase() !== stationCode)) throw new Error("Station mismatch in COD source.");
  const value = data.balance_due;
  if (value == null || String(value).trim() === "" || !Number.isFinite(Number(value))) throw new Error("Missing COD amount.");
  const amount = Math.round(Number(value) * 100) / 100;
  if (amount < 0) throw new Error("Negative COD balance needs reconciliation.");
  if (amount === 0) return null;
  const pendingDate = String(data.cash_with_associate_dt || "").slice(0,10);
  const bucket = String(data.age_bucket || "Age not supplied");
  return {
    rowNumber:row.row_number, trackingId:String(data.tracking_id || ""), orderId:String(data.order_id || ""),
    associate:String(data.employee_name || "Associate not supplied"), associateId:String(data.performed_by_2 || "").replace(/\.0$/, ""),
    pendingDate:/^\d{4}-\d{2}-\d{2}$/.test(pendingDate)?pendingDate:"", bucket,
    status:String(data.status_code || "Status not supplied").replace(/_/g," "), amount,
    overdue:codAgeConcern(bucket,pendingDate,importedAt)
  };
}

export function summarizeReviewCod(lines: ReviewCodLine[]): ReviewCodSummary {
  const buckets = new Map<string,ReviewCodGroup>();
  const days = new Map<string,ReviewCodGroup>();
  let cents=0,overdueCents=0;
  for (const line of lines) {
    const amount=Math.round(line.amount*100);
    cents+=amount; if(line.overdue)overdueCents+=amount;
    for (const [map,label] of [[buckets,line.bucket],[days,line.pendingDate||"Date not supplied"]] as const) {
      const group=map.get(label)||{label,amount:0,lines:0,overdue:false};
      group.amount+=amount; group.lines++; group.overdue ||= line.overdue; map.set(label,group);
    }
  }
  const amounts=(map:Map<string,ReviewCodGroup>)=>[...map.values()].map(group=>({...group,amount:group.amount/100}));
  return {total:cents/100,overdueAmount:overdueCents/100,tidCount:new Set(lines.map(line=>line.trackingId).filter(Boolean)).size,lineCount:lines.length,
    tone:!cents?"green":overdueCents?"red":"neutral",
    buckets:amounts(buckets).sort((a,b)=>(parseInt(a.label)||0)-(parseInt(b.label)||0)),
    days:amounts(days).sort((a,b)=>a.label.localeCompare(b.label))};
}
