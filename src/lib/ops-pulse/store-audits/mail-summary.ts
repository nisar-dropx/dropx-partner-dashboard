import { questions, score, scoreBand, type StoreAudit } from './model';
const esc = (v: string) => v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const date = (v: string) => v ? new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'})+' IST' : 'Not set';
/** Keep the email actionable; the complete questionnaire and evidence remain in the PDF. */
export function auditCompletionSummary(a: StoreAudit, url: string) {
 const pct=a.score ?? score(a), band=a.score_band ?? scoreBand(pct);
 const gaps=questions(a.template).filter(q=>a.answers[q.id]?.outcome==='gap');
 const headline=`${a.store_name} · ${pct == null ? 'Not scored' : pct+'%'}${band?' · '+band:''}`;
 const items=gaps.slice(0,8).map(q=>({label:q.label,...a.answers[q.id]}));
 const text=[headline,`${a.number} · ${gaps.length} findings`,...items.map(g=>`${g.label}\nAction: ${g.action || 'Review finding'} | Owner: ${g.owner || 'Store team'} | Due: ${date(g.dueAt)}`),gaps.length>8?`+${gaps.length-8} more findings in the attached report.`:'',`Submit action taken and required proof in OpsPulse: ${url}`].filter(Boolean).join('\n\n');
 const html=`<div style="font:13px Arial;color:#213047;max-width:760px;margin:auto"><header style="background:#172033;color:white;border-top:4px solid #f45b2b;padding:18px"><small>OPSPULSE · STORE AUDIT COMPLETED</small><h1 style="font-size:21px;margin:8px 0">${esc(headline)}</h1><span>${esc(a.number)} · ${gaps.length} findings</span></header><p>Review the findings below. Submit action taken and required closure evidence in OpsPulse. The full audit report is attached.</p>${items.length?`<table style="width:100%;border-collapse:collapse;text-align:left"><thead><tr>${['Finding','Action / owner','Due'].map(t=>`<th style="padding:9px;background:#f3f5f8">${t}</th>`).join('')}</tr></thead><tbody>${items.map(g=>`<tr><td style="padding:9px;border-bottom:1px solid #e2e8f0">${esc(g.label)}</td><td style="padding:9px;border-bottom:1px solid #e2e8f0">${esc(g.action||'Review finding')}<br><small>${esc(g.owner||'Store team')}</small></td><td style="padding:9px;border-bottom:1px solid #e2e8f0">${esc(date(g.dueAt))}</td></tr>`).join('')}</tbody></table>`:'<p>No corrective findings were recorded.</p>'}${gaps.length>8?`<p>+${gaps.length-8} more findings in the attached report.</p>`:''}<p><a style="display:inline-block;padding:11px 16px;background:#e85120;color:white;border-radius:7px;text-decoration:none" href="${esc(url)}">Open audit and respond</a></p></div>`;
 return {text,html};
}
