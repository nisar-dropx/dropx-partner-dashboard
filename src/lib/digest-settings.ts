export function validateDigestSettings(form:FormData,current:Record<string,unknown>){
 const state=String(form.get('state')||'');
 const time=String(form.get('schedule_time')||'');
 const subject=String(form.get('subject')||'').trim();
 const reminder=String(form.get('reminder')||'').trim();
 const paused=String(form.get('paused_until')||'');
 if(!['enabled','paused','disabled'].includes(state))throw new Error('Choose a valid delivery state.');
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('Choose a valid daily time.');
 if(!subject||subject.length>250||/[\r\n]/.test(subject)||!subject.includes('{{month}}')||!subject.includes('{{year}}'))throw new Error('The monthly subject must include {{month}} and {{year}}, on one line.');
 if(/\{\{(?!month\}\}|year\}\})/.test(subject))throw new Error('Only {{month}} and {{year}} subject tokens are supported.');
 if(reminder.length>1000)throw new Error('Keep the manager reminder below 1,000 characters.');
 const pausedUntil=paused?new Date(paused+'+05:30'):null;
 if(pausedUntil&&!Number.isFinite(pausedUntil.getTime()))throw new Error('Choose a valid resume time (IST).');
 const scopeCodes:Record<string,string[]>={};
 for(const key of ['included_models','recipient_role_codes','location_role_codes'])if(Array.isArray(current[key])){
  const values=[...new Set(String(form.get(key)||'').split(',').map(v=>v.trim().toUpperCase()).filter(Boolean))];
  if(!values.length||values.some(v=>! /^[A-Z0-9_]{1,40}$/.test(v)))throw new Error('Enter valid comma-separated master codes.');
  scopeCodes[key]=values;
 }
 return {state,paused_until:state==='paused'&&pausedUntil?pausedUntil.toISOString():null,subject_template:subject,config:{...current,...scopeCodes,schedule_time:time,timezone:'Asia/Kolkata',day_offset:-1,thread_mode:'monthly',manager_reminder:reminder,send_zero_cases:form.get('send_zero_cases')==='on'}};
}
