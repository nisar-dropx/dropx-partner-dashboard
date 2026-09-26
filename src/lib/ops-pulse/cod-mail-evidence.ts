import {CONTROL_TOWER_CC} from './cod-proof-policy';
export type EmailEvidence={internalDate?:string;payload?:{headers?:{name:string;value:string}[]}};
const addresses=(raw:string)=>[...raw.toLowerCase().replace(/"(?:[^"\\]|\\.)*"/g,'').matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g)].map(m=>m[0]);
export function matchesCodEmail(message:EmailEvidence,record:{email_subject:string|null;sender_email:string|null;email_sent_at:string|null;stakeholder_emails:string[];client_poc_emails:string[]}){
 const header=(name:string)=>(message.payload?.headers||[]).filter(h=>h.name.toLowerCase()===name).map(h=>h.value).join(', ');
 const subject=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
 if(!record.email_subject||subject(header('subject'))!==subject(record.email_subject))return false;
 const from=header('from'), actualFrom=from.match(/<([^<>]+)>/)?.[1]?.trim().toLowerCase()||from.trim().toLowerCase();
 if(!record.sender_email||actualFrom!==record.sender_email.toLowerCase())return false;
 if(!addresses(header('cc')).includes(CONTROL_TOWER_CC))return false;
 const to=[...addresses(header('to')),...addresses(header('cc'))];
 if(![...record.stakeholder_emails,...record.client_poc_emails].every(email=>to.includes(email.toLowerCase())))return false;
 const at=Number(message.internalDate),expected=Date.parse(record.email_sent_at||'');
 return Number.isFinite(at)&&Number.isFinite(expected)&&Math.abs(at-expected)<=60*60*1000;
}
