import type {AuthorizationContext} from '@/lib/authorization';
const reviewers = new Set(['jamsheer@dropxlogistics.com','ct@dropxlogistics.com','tech@dropxlogistics.com']);
export function canReturnCodSlip(auth:AuthorizationContext) {
 return !auth.readOnly && !auth.isPreview && Boolean(auth.companyId) && reviewers.has((auth.email||'').trim().toLowerCase()) && ![auth.roleCode,...(auth.effectiveRoleCodes||[])].some(code=>/(^|_)LOCATION$/.test(code||''));
}
export function compactCodReason(reason:string|null|undefined) {
 const text=(reason||'').trim();
 const rules:[RegExp,string][]=[[/Handwriting unclear/i,'Handwriting unclear'],[/does not clearly show a CMS|not a deposit slip/i,'Wrong document'],[/slip is unreadable/i,'Unreadable slip'],[/amount.+does not match/i,'Amount mismatch'],[/amount is not readable/i,'Amount unclear'],[/Slip date.+does not match/i,'Date mismatch'],[/date is not readable/i,'Date unclear'],[/station code.+does not match/i,'Station mismatch'],[/Remittance code.+does not match/i,'Remittance mismatch'],[/Receipt .+not readable/i,'Receipt number unclear'],[/seal is missing/i,'Seal missing'],[/seal is below medium/i,'Seal unclear'],[/completed deposit acknowledgement/i,'Deposit acknowledgement missing']];
 const matches=rules.filter(([pattern])=>pattern.test(text)).map(([,label])=>label);
 return matches.length?[...new Set(matches)].join('; '):text.length>160?text.slice(0,157)+'…':text;
}
export function returnThreadSubject(station:string){return `COD slip corrections · ${station.replace(/[\r\n]/g,' ').trim()}`;}
export function returnMessageId(id:string){return `<cod-return-${id}@dropxlogistics.com>`;}
export function returnMail(input:{station:string;date:string;reference:string;reason:string;actor:string;submissionId:string;locationId:string}){
 const esc=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 const url='https://ops.dropxlogistics.com/cod/submission?'+new URLSearchParams({deposit_date:input.date,location:input.locationId,edit:input.submissionId});
 const text=`${input.station} · COD slip returned\nDeposit: ${input.date} · Reference: ${input.reference}\nReason: ${input.reason}\nReturned by: ${input.actor}\nReplace the slip: ${url}`;
 return {text,html:`<div style="background:#f4f6fa;padding:24px;font-family:Arial,sans-serif;color:#172b45"><div style="max-width:620px;margin:auto;background:#fff;border-top:4px solid #ed4824;padding:24px;border-radius:8px"><strong style="color:#ed4824">DROPX · OPSPULSE</strong><h2 style="margin:16px 0">${esc(input.station)} · Slip returned</h2><p>${esc(input.date)} · ${esc(input.reference)}</p><p style="background:#fff1f2;border-left:3px solid #dc2626;padding:12px;color:#991b1b">${esc(input.reason)}</p><p style="color:#64748b;font-size:12px">Returned by ${esc(input.actor)}</p><a href="${esc(url)}" style="display:inline-block;background:#ed4824;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">Re-upload correct slip</a><p style="font-size:12px;color:#64748b">Replace this submission in OpsPulse. Future returns for this station stay in this conversation.</p></div></div>`};
}
