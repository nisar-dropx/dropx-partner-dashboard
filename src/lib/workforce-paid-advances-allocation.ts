export type Row = { id: string; reviewSubjectType?: string; reviewSubjectId?: string | null; locationId: string | null;
  deductions: number; netAmount: number; deductionBreakdown: Array<{ code: string; label: string; amount: number; recoveryKey?: string }> };
type Due = { advance_id: string; worker_id: string; paid_at: string; amount: number | string };
type Payment = { workforce_id: string; status: string; instruction_amount: number | string };
export type Prior = { workforce_id: string; station_id: string; advance_id: string; amount: number };
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Calculate once across all stations, then apply visibility filtering. Existing
 * publication allocations stay at their station; new principal uses unpaid pay. */
export function fitWorkforceAdvances<R extends Row>(rows: R[], due: Due[], payments: Payment[], prior: Prior[]) {
  const append = (row: R, id: string, amount: number) => {
    const key = `ADVANCE:${id}`;
    const existing = row.deductionBreakdown.find(d => d.recoveryKey === key);
    if (existing) existing.amount = round(existing.amount + amount);
    else row.deductionBreakdown.push({ code: "ADVANCE_RECOVERY", label: "Advance deduction", amount, recoveryKey: key });
    row.deductions = round(row.deductions + amount); row.netAmount = round(row.netAmount - amount);
  };
  for (const workerId of new Set(due.map(d => d.worker_id))) {
    const targets = rows.filter(r => (r.reviewSubjectType ?? "workforce") === "workforce" && r.reviewSubjectId === workerId)
      .sort((a,b) => String(a.locationId).localeCompare(String(b.locationId)) || a.id.localeCompare(b.id));
    if (!targets.length) continue;
    const bank = payments.filter(p => p.workforce_id === workerId);
    const paid = bank.filter(p => p.status === "paid").reduce((sum,p) => sum + Number(p.instruction_amount),0);
    const processing = bank.some(p => p.status === "processing");
    const workerDue=due.filter(d => d.worker_id === workerId).sort((a,b) => a.paid_at.localeCompare(b.paid_at) || a.advance_id.localeCompare(b.advance_id));
    // Preserve every prior deduction before measuring capacity for a new one.
    for (const line of workerDue) {
      let remaining=Number(line.amount);
      for (const previous of prior.filter(p=>p.workforce_id===workerId && p.advance_id===line.advance_id)) {
        const target=targets.find(r=>r.locationId===previous.station_id);
        if(!target || previous.amount>remaining+0.001 || previous.amount>target.netAmount+0.001)
          throw new Error("An existing advance deduction no longer fits its payout. Review the changed payout before publishing.");
        append(target,line.advance_id,previous.amount);remaining=round(remaining-previous.amount);
      }
    }
    for (const line of workerDue) {
      if(processing || prior.some(p=>p.workforce_id===workerId && p.advance_id===line.advance_id)) continue;
      let remaining=Number(line.amount);
      let available = Math.max(0, round(targets.reduce((sum,r) => sum+r.netAmount,0)-paid));
      for (const target of targets) {
        const amount = round(Math.min(remaining,available,Math.max(0,target.netAmount)));
        if (amount<=0) continue;
        append(target,line.advance_id,amount); remaining=round(remaining-amount); available=round(available-amount);
      }
    }
  }
  return rows;
}

