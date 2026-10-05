import * as XLSX from 'xlsx';
import type { ExpenseVarianceRow } from './expense-variance-data';
import type { DigestAttachment } from './portal-digest-attachments';
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money = (n: number | null) => n == null ? 'Pending' : '₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2});
export function adHocCostMail(rows: ExpenseVarianceRow[], date: string) {
 const day=rows.filter(r=>r.date===date&&!r.excluded),matched=day.filter(r=>r.estimated!=null&&r.actual!=null),over=day.filter(r=>r.overrun);
 const totalEstimate=matched.reduce((s,r)=>s+r.estimated!,0), totalActual=matched.reduce((s,r)=>s+r.actual!,0);
 const pending=day.filter(r=>r.actual==null).length;
 const summary=matched.length ? `Comparable estimate ${money(totalEstimate)} · Actual submitted ${money(totalActual)} · Difference ${money(totalActual-totalEstimate)}` : 'No comparable submitted actuals yet';
 const headers=['Station / request','Type','Estimate','Actual','Difference'];
 const html=`<h3 style="font-size:16px;margin:22px 0 6px;color:#173b45">Estimated vs actual · ${escape(date)}</h3><p style="font-size:12px;color:#52656d;margin:5px 0">${escape(summary)}</p><p style="font-size:12px;color:${over.length?'#b4233e':'#52656d'};margin:5px 0 10px"><b>${over.length} over estimate</b> · ${pending} actuals pending</p>${over.length?`<table width="100%" style="border-collapse:collapse;font-size:12px"><tr>${headers.map(h=>`<th style="padding:7px;text-align:left;background:#fff0f2;color:#9f2840">${h}</th>`).join('')}</tr>${over.slice(0,10).map(r=>`<tr>${[`${r.station} · ${r.reference}`,r.head,money(r.estimated),money(r.actual),'+'+money(r.delta)].map(v=>`<td style="padding:7px;border-bottom:1px solid #e5e7eb">${escape(v)}</td>`).join('')}</tr>`).join('')}</table>`:''}<p style="font-size:11px;color:#64748b">${over.length>10?'First 10 overruns shown. ':''}Excel includes all scoped MTD request comparisons. Actual = submitted cost, not paid. Missing actuals are not zero.</p>`;
 const workbook=XLSX.utils.book_new();
 const exported=rows.map(r=>({Date:r.date,Station:r.station,Reference:r.reference,'Payment head':r.head,Status:r.status,'Estimate INR':r.estimated,'Actual submitted INR':r.actual,'Variance INR':r.delta,'Variance %':r.percent==null?null:Number(r.percent.toFixed(2)),Attention:r.state,'Estimated shipments':r.shipments,'Estimated CPS':r.cps==null?null:Number(r.cps.toFixed(2))}));
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(exported.length?exported:[{Information:'No expense request comparisons in scope.'}]),'Estimated vs Actual');
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{ReportDate:date,Basis:'Deployment/work date; monthly through report date.',Actual:'Submitted cost, not bank settlement. Blank means pending.',Estimate:'Saved expense estimate; legacy edits may have changed historical estimates.',CPS:'Request amount / entered request shipments, not station inbound.'}]),'Read me');
 const attachments: DigestAttachment[]=[{filename:`DropX-Adhoc-Comparison-${date}.xlsx`,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',encoding:'base64',content:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}).toString('base64')}];
 return {html,text:`Estimated vs actual · ${date}\n${summary}\n${over.length} over estimate; ${pending} actuals pending. Full scoped MTD comparisons attached.`,attachments};
}
