export type PayrollPreview = {
  hash: string; changed: boolean; runApproved: boolean; peopleCount: number;
  readyCount: number; amountPaise: number; excludedCount: number;
  issues: { name: string; reason: string }[];
  people: { worker: string; name: string; status: string; net: number; paid: number; remaining: number; payable: number; processing: number; bankLast4: string; exclusion: string | null; items: { code: string; amount: number; type: string }[] }[];
};
export type FinanceSubmission = Omit<PayrollPreview, 'people'> & {
  id: string; station_id: string; station: string; station_name: string; run_id: string; status: string; version: number;
  submitted_by: string; submitted_name: string; submitted_at: string; review_note: string;
  run: { label: string; period_start: string }; clearance: boolean; lossPending: number; clearanceRequired: boolean;
  canApprove: boolean; canDownload: boolean; nextStep: string;
};
export function payrollNextStep(r: { changed: boolean; runApproved: boolean; status: string; clearance: boolean; clearanceRequired: boolean; readyCount: number; issues: {name:string;reason:string}[]; submitted_by: string; submitted_name: string }, actor: string) {
  if (r.changed) return 'People must resubmit revised payroll';
  if (!r.runApproved) return 'Approve this location in People';
  if (r.status === 'returned') return 'Returned to People for correction';
  if (!r.clearance && r.clearanceRequired) return 'NL / SLP clearance needed';
  if (r.status !== 'approved') return r.submitted_by === actor ? `Awaiting another Finance approver · submitted by ${r.submitted_name}` : 'Review and approve payroll';
  if (r.issues.length) return `${r.issues[0].name}: ${r.issues[0].reason}`;
  if (!r.readyCount) return 'No new payment ready · check paid, processing or held people';
  return 'Ready for bank file';
}
export function selectionExpected(rows: FinanceSubmission[]) {
  return Object.fromEntries(rows.map(r => [r.id, { version: r.version, hash: r.hash, readyCount: r.readyCount, amountPaise: r.amountPaise }]));
}
