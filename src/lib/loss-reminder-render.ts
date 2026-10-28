import * as XLSX from 'xlsx';
import {LOSS_REMINDER_COPY,lossReminderIncludesMonth,lossReminderPeriodLabel,lossReminderThreadMonth,lossReminderEdition,type LossReminderStage,type ReminderRow} from './loss-reminder-policy';
const e=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(n:number)=>'₹'+n.toLocaleString('en-IN',{maximumFractionDigits:2});
const sum=(rows:ReminderRow[])=>Math.round(rows.reduce((n,r)=>n+r.amount,0)*100)/100;
const origin='https://ops.dropxlogistics.com';
export function renderLossReminder(input:{stage:LossReminderStage;event:string;date:string;rows:ReminderRow[];checkedAt:string;warnings?:string[];sample?:boolean;scheduledTime?:string}){
 const {stage,date}=input,rows=input.rows.filter(r=>lossReminderIncludesMonth(stage,date,r.report==='NL'?'nl':'slp',r.month)),period=lossReminderPeriodLabel(stage,date),copy=LOSS_REMINDER_COPY[stage],pending=rows.filter(r=>r.pending),month=lossReminderThreadMonth(input.event,date);
 const monthName=new Date(month+'-01T12:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'Asia/Kolkata'});
 const subject=`OpsPulse · ${copy.title} · ${monthName}`;
 const stations=[...new Set(pending.map(r=>r.station))].map(code=>{
  const all=rows.filter(r=>r.station===code),p=all.filter(r=>r.pending),nl=p.filter(r=>r.report==='NL'),slp=p.filter(r=>r.report==='SLP Final');
  const nu=all.filter(r=>r.report==='NL'&&!r.pending),su=all.filter(r=>r.report==='SLP Final'&&!r.pending);
  return {code,owner:p[0].owner,nl:nl.length,nlValue:sum(nl),nlUpdated:nu.length,nlUpdatedValue:sum(nu),slp:slp.length,slpValue:sum(slp),slpUpdated:su.length,slpUpdatedValue:sum(su),pending:p.length,amount:sum(p),updated:all.length-p.length,total:all.length,month:[...new Set(p.map(r=>r.month))].sort().join(', '),link:p[0].link};
 }).sort((a,b)=>b.amount-a.amount||a.code.localeCompare(b.code));
 const headers=stage==='recovery'?['Station / owner','NL pending','NL updated','SLP pending','SLP updated']:['Station / owner','Pending','Shipment value','Loss month'];
 const metric=(count:number,value:number)=>`<strong>${count}</strong><div style="font-size:11px;color:#64748b">${e(money(value))}</div>`;
 const tableRows=stations.map((s,i)=>`<tr style="background:${i%2?'#f8fafc':'#ffffff'}"><td style="padding:9px 7px;border-bottom:1px solid #e2e8f0"><a href="${e(origin+s.link)}" style="font-weight:bold;color:#22324a;text-decoration:none">${e(s.code)} ↗</a><div style="font-size:11px;color:#64748b;margin-top:3px">${e(s.owner)}</div></td>${(stage==='recovery'?[metric(s.nl,s.nlValue),metric(s.nlUpdated,s.nlUpdatedValue),metric(s.slp,s.slpValue),metric(s.slpUpdated,s.slpUpdatedValue)]:[e(s.pending),e(money(s.amount)),e(s.month)]).map(v=>`<td style="padding:9px 7px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap">${v}</td>`).join('')}</tr>`).join('');

 const title=input.sample?'EXAMPLE DATA · NOT SENT':'ACTION NEEDED';
 const stamp=new Date(input.checkedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
 const stats=[['Pending shipments',pending.length],['Pending value',money(sum(pending))],['Stations',stations.length]];
 const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head><body style="margin:0;background:#f1f4f8;font:13px/1.45 Arial,sans-serif;color:#1d2b42"><div style="max-width:760px;margin:20px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden"><div style="padding:18px 20px;background:#17243b;color:white;border-top:4px solid ${copy.color}"><div style="font-size:10px;letter-spacing:1.2px;color:#ffb58f;font-weight:bold">OPSPULSE · ${title}</div><h1 style="font-size:21px;line-height:1.3;margin:6px 0">${e(copy.title)}</h1><div style="font-size:12px;color:#cbd5e1">${e(date)} · ${lossReminderEdition(input.event,input.scheduledTime)} IST · ${e(period)}</div></div><div style="padding:14px 16px"><table role="presentation" style="width:100%;border-collapse:collapse"><tr>${stats.map(([label,value])=>`<td style="width:33%;padding:8px;background:#fff4eb;border-right:4px solid white"><strong style="font-size:21px;color:${copy.color}">${e(value)}</strong><div style="font-size:11px;color:#64748b">${label}</div></td>`).join('')}</tr></table><p style="margin:12px 0;font-size:12px">${copy.note}</p><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${headers.map((h,i)=>`<th style="padding:8px 10px;background:#eef2f7;color:#516078;text-align:${i?'right':'left'};font-size:10px">${h.toUpperCase()}</th>`).join('')}</tr></thead><tbody>${tableRows||'<tr><td colspan="5" style="padding:16px;color:#168264">No pending actions. No scheduled email will be sent.</td></tr>'}</tbody></table><div style="margin-top:14px"><a href="${origin}/team-ops/losses/nl" style="display:inline-block;background:${copy.color};color:white;padding:9px 13px;border-radius:6px;font-size:12px;text-decoration:none;font-weight:bold">${copy.action} →</a><span style="font-size:11px;color:#64748b"> &nbsp; Shipment details in Excel</span></div>${(input.warnings||[]).map(w=>`<p style="background:#fff4d6;padding:8px;color:#8a5105;font-size:11px">${e(w)}</p>`).join('')}<p style="font-size:11px;color:#64748b;margin:12px 0 0">${stage==='recovery'?'Updated = recovery details saved; this is not a payroll-debit confirmation.':'Only station actions are included; cases waiting with Amazon or the filing desk are excluded.'}<br>Checked ${e(stamp)} IST · ${stage==='recovery'?'Same thread: 20th–5th recovery cycle.':'Same thread throughout the month.'}</p></div></div></body></html>`;
 if(Buffer.byteLength(html)>95000)throw Error('Loss reminder exceeds the email size limit.');
 const text=[subject,period,`${date} · ${lossReminderEdition(input.event,input.scheduledTime)} IST`,`${pending.length} pending shipments · ${money(sum(pending))} · ${stations.length} stations`,copy.note,...stations.map(s=>`${s.code} · ${s.owner} | ${stage==='recovery'?`NL: ${s.nl} pending / ${money(s.nlValue)}, ${s.nlUpdated} updated / ${money(s.nlUpdatedValue)} | SLP: ${s.slp} pending / ${money(s.slpValue)}, ${s.slpUpdated} updated / ${money(s.slpUpdatedValue)}`:`${s.pending} pending | ${money(s.amount)}`}`),...(input.warnings||[]),'Shipment-level Excel attached.',origin+'/team-ops/losses/nl'].join('\n');
 const wb=XLSX.utils.book_new();
 if(stage==='recovery'){
  const summary=XLSX.utils.json_to_sheet(stations.map(s=>({'Station':s.code,'Owner':s.owner,'NL pending count':s.nl,'NL pending value':s.nlValue,'NL updated count':s.nlUpdated,'NL updated value':s.nlUpdatedValue,'SLP pending count':s.slp,'SLP pending value':s.slpValue,'SLP updated count':s.slpUpdated,'SLP updated value':s.slpUpdatedValue})));
  summary['!cols']=[{wch:14},{wch:28},...Array.from({length:8},()=>({wch:20}))];
  XLSX.utils.book_append_sheet(wb,summary,'Station summary');
 }
 for(const report of stage==='recovery'?['NL','SLP Final']:['NL']){
  const items=pending.filter(r=>r.report===report);
  const ws=XLSX.utils.aoa_to_sheet([['Station','Owner','Report','Loss month','Shipment ID','Shipment value','Pending action','Open in OpsPulse'],...items.map(r=>[r.station,r.owner,r.report,r.month,String(r.shipmentId),r.amount,r.status,origin+r.link])]);
  ws['!cols']=[{wch:14},{wch:30},{wch:14},{wch:14},{wch:24},{wch:20},{wch:42},{wch:80}];ws['!autofilter']={ref:`A1:H${items.length+1}`};
  items.forEach((r,i)=>{ws[`F${i+2}`].z='"₹"#,##0.00';ws[`H${i+2}`].l={Target:origin+r.link};});
  XLSX.utils.book_append_sheet(wb,ws,report==='NL'?'NL pending':'SLP pending');
 }
 const filename=`OpsPulse_${stage}_${date}.xlsx`,bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;
 return {subject,html,text,pending:pending.length,stationIds:[...new Set(pending.map(r=>r.stationId))],attachment:{filename,content:bytes.toString('base64'),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const,encoding:'base64' as const}};
}
