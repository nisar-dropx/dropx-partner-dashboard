export const ADVANCE_FINANCE_EVENT = "advance_finance_daily";
export type AdvanceFinanceRow = {
  company_id: string; request_id: string; request_number: string; worker_name: string;
  worker_code: string | null; station_code: string | null; requested_amount: number | string;
  approved_amount: number | string | null; reason: string | null; requested_at: string;
  available_at: string; approver_user_id: string; recipient_email: string;
  recipient_name: string | null; queue_stage: "approval" | "payment";
};
const escape = (s: unknown) => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const money = (n: number) => `₹${n.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
export function advanceFinanceCutoff(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("Invalid advance report date");
  const cutoff = new Date(`${date}T17:00:00+05:30`);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString().slice(0,10)!==date) throw Error("Invalid advance report date");
  return cutoff.toISOString();
}
export function advanceFinanceMessages(rows: AdvanceFinanceRow[], company: string, date: string, domain: string, subject: string) {
  const cutoff = advanceFinanceCutoff(date), groups = new Map<string,AdvanceFinanceRow[]>(), seen = new Set<string>();
  for (const row of rows) {
    if (row.company_id !== company) throw Error("Advance queue company mismatch");
    if (!Number.isFinite(Date.parse(row.available_at)) || !Number.isFinite(Date.parse(row.requested_at))) throw Error("Advance queue date is invalid");
    if (Date.parse(row.available_at)>Date.parse(cutoff) || Date.parse(row.requested_at)>Date.parse(cutoff)) continue;
    const email = row.recipient_email.trim().toLowerCase();
    if (!domain || !email.endsWith(`@${domain}`) || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw Error("Finance assignee has no permitted company email");
    if (seen.has(row.request_id)) throw Error("An advance has multiple finance owners");
    seen.add(row.request_id);
    const amount = Number(row.queue_stage === "payment" ? row.approved_amount : row.requested_amount);
    if (!Number.isFinite(amount) || amount <= 0) throw Error("Advance queue amount is invalid");
    groups.set(email,[...(groups.get(email) ?? []),row]);
  }
  return [...groups.entries()].map(([email,queue]) => {
    queue.sort((a,b)=>a.requested_at.localeCompare(b.requested_at)||a.request_id.localeCompare(b.request_id));
    const approvals=queue.filter(r=>r.queue_stage==="approval"), payments=queue.filter(r=>r.queue_stage==="payment");
    const approvalTotal=approvals.reduce((s,r)=>s+Number(r.requested_amount),0),paymentTotal=payments.reduce((s,r)=>s+Number(r.approved_amount),0);
    const title=`Advance queue · ${date} · 5 p.m. IST`;
    const summary=`${approvals.length} awaiting finance approval (${money(approvalTotal)}); ${payments.length} approved, awaiting payment (${money(paymentTotal)}).`;
    const note="Includes outstanding requests received by 5 p.m. IST, including earlier days. Later arrivals appear in the next daily email. Open the portal for the latest status and to record decisions; replying to this email does not approve or pay a request.";
    const lines=queue.map(r=>`${r.request_number} · ${r.worker_name} (${r.worker_code||"—"}) · ${r.station_code||"—"} · ${r.queue_stage==="approval"?"Approval required":"Awaiting payment"} · ${money(Number(r.queue_stage==="payment"?r.approved_amount:r.requested_amount))} · ${r.reason||"—"}`);
    const link="https://one.dropxlogistics.com/approvals?section=pay-advances", payLink="https://fin.dropxlogistics.com/payments/process";
    return {email,name:queue[0].recipient_name||"Finance Manager",subject:subject.replace(/[\r\n]+/g," "),
      text:[title,summary,...lines,note,`Review advances: ${link}`,`Process approved payments: ${payLink}`].join("\n\n"),
      html:`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#203047"><div style="max-width:900px;margin:auto;padding:24px"><p>DROPX · FIN</p><h1 style="font-size:22px">${escape(title)}</h1><p>${escape(summary)}</p><table style="width:100%;border-collapse:collapse"><thead><tr>${["Request / team member","Location","Action","Amount","Reason"].map(s=>`<th style="padding:10px;text-align:left;border-bottom:2px solid #ddd">${s}</th>`).join("")}</tr></thead><tbody>${queue.map(r=>`<tr>${[`${r.request_number} · ${r.worker_name} (${r.worker_code||"—"})`,r.station_code||"—",r.queue_stage==="approval"?"Approval required":"Awaiting payment",money(Number(r.queue_stage==="payment"?r.approved_amount:r.requested_amount)),r.reason||"—"].map(s=>`<td style="padding:10px;border-bottom:1px solid #ddd">${escape(s)}</td>`).join("")}</tr>`).join("")}</tbody></table><p><a href="${link}">Review advances</a> · <a href="${payLink}">Process approved payments in Fin</a></p><p style="font-size:12px;color:#627082">${escape(note)}</p><p style="font-size:12px;color:#627082">Daily editions stay in this email conversation.</p></div></body></html>`,
      scope:{requestIds:queue.map(r=>r.request_id),approverUserIds:[...new Set(queue.map(r=>r.approver_user_id))],reportDate:date,cutoff,approvalTotal,paymentTotal}
    };
  });
}
