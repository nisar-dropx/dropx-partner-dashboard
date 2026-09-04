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

export function codAgeOverTwo(bucket: string, pendingDate: string, importedAt: string): boolean {
  // Use Amazon's age bands as supplied; never recalculate a valid band using today's date.
  const band = bucket.trim().match(/^(\d{1,3})(?:\s*[-–]\s*\d{1,3}|\+)?\s*DAYS?$/i);
  if (band && Number(band[1]) !== 2) return Number(band[1]) > 2;
  if (band && !bucket.includes("+") && !/[-–]/.test(bucket)) return false;
  // Legacy/unknown labels (e.g. a year) stay visible verbatim; dates only determine their alert.
  const importedDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(importedAt));
  const days = (Date.parse(`${importedDay}T00:00:00Z`) - Date.parse(`${pendingDate}T00:00:00Z`)) / 86400000;
  return Number.isFinite(days) && days > 2;
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
    overdue:codAgeOverTwo(bucket,pendingDate,importedAt)
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
