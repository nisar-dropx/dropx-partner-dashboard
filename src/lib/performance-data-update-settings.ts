export function validatePerformanceDataUpdateSettings(form:FormData,current:Record<string,unknown>) {
 const state=String(form.get('state')||'');
 const subject=String(form.get('subject')||'').trim();
 const body=String(form.get('body')||'').trim();
 const paused=String(form.get('paused_until')||'');
 if(!['enabled','paused','disabled'].includes(state))throw new Error('Choose a valid delivery state.');
 if(!subject||subject.length>250||/[\r\n]/.test(subject)||!subject.includes('{{month}}')||!subject.includes('{{year}}')||/\{\{(?!month\}\}|year\}\})/.test(subject))throw new Error('Use {{month}} and {{year}} in a one-line monthly subject.');
 if(!body||body.length>1000||!body.includes('{{date}}')||/\{\{(?!date\}\})/.test(body))throw new Error('Include {{date}} in the message (up to 1,000 characters).');
 const pausedUntil=paused?new Date(paused+'+05:30'):null;
 if(pausedUntil&&!Number.isFinite(pausedUntil.getTime()))throw new Error('Choose a valid resume time (IST).');
 const codes:Record<string,string[]>={};
 for(const key of ['included_models','recipient_role_codes']) {
  codes[key]=[...new Set(String(form.get(key)||'').split(',').map(v=>v.trim().toUpperCase()).filter(Boolean))];
  if(!codes[key].length||codes[key].some(v=>!/^[A-Z0-9_]{1,60}$/.test(v)))throw new Error('Enter valid comma-separated model / Ops role codes.');
 }
 return {state,paused_until:state==='paused'&&pausedUntil?pausedUntil.toISOString():null,subject_template:subject,body_template:body,config:{...current,...codes}};
}
