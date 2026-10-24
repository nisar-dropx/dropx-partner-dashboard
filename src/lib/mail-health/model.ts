export type Mode = 'daily' | 'event' | 'setup';
export type Source = {
  key: string; table: string; label: string; portal: string;
  mode: Mode; time: string; timezone: string; graceMinutes: number; queueMinutes: number;
  owner: string; enabled: boolean; dayOffset: number; startDate?: string; endDate?: string;
  statusField: string; timeField: string; dateField?: string; recipientField?: string;
  errorField?: string; filters?: Record<string, string>;
  control?: { state: string; pausedUntil?: string; ready: boolean };
  settings?: { table: string; enabled: string; time?: string; start?: string };
};
export type Entry = { id: string; status: string; at: string | null; date: string | null; recipient: string; error: string };
export type Health = {
  source: Source; state: 'attention' | 'ok' | 'paused' | 'setup' | 'unknown' | 'idle';
  message: string; dueDate: string | null; expected: number | null;
  accepted: number; failed: number; uncertain: number; queued: number; skipped: number;
  lastActivity: string | null; entries: Entry[]; warnings: string[];
};
export const base = { mode: 'setup' as Mode, time: '14:00', timezone: 'Asia/Kolkata', graceMinutes: 30, queueMinutes: 30, owner: '', enabled: true, dayOffset: 0 };
const accepted = new Set(['accepted', 'sent', 'delivered']);
const failed = new Set(['failed', 'error']);
const uncertain = new Set(['uncertain', 'needs_review']);
const queued = new Set(['queued', 'pending', 'sending']);
export function localParts(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(v => [v.type,v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour)*60+Number(p.minute) };
}
export function shiftDate(date: string, days: number) { const d=new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
export function dueDate(source: Source, now: Date) {
  if (source.mode !== 'daily') return null;
  const local=localParts(now,source.timezone), [h,m]=source.time.split(':').map(Number);
  const sendDay=shiftDate(local.date, Math.floor((local.minute-h*60-m-source.graceMinutes)/1440));
  if(source.startDate && sendDay<source.startDate) return null;
  if(source.endDate && sendDay>source.endDate) return null;
  return shiftDate(sendDay,source.dayOffset);
}
export function evaluate(source: Source, entries: Entry[], now=new Date(), run?: {count:number; date:string}, warnings: string[]=[]): Health {
  const due=dueDate(source,now);
  const rows=source.mode==='daily'&&due ? entries.filter(e=>e.date===due) : entries;
  const result:Health={source,state:'idle',message:'No recent activity; this is not proof of delivery.',dueDate:due,expected:run?.date===due?run.count:null,accepted:0,failed:0,uncertain:0,queued:0,skipped:0,lastActivity:entries.map(e=>e.at).filter((v):v is string=>!!v).sort().at(-1)??null,entries:[...entries].sort((a,b)=>Number(uncertain.has(b.status)||queued.has(b.status)||failed.has(b.status))-Number(uncertain.has(a.status)||queued.has(a.status)||failed.has(a.status))||(b.at??'').localeCompare(a.at??'')).slice(0,100),warnings};
  for(const e of rows){if(accepted.has(e.status))result.accepted++;else if(failed.has(e.status))result.failed++;else if(uncertain.has(e.status))result.uncertain++;else if(queued.has(e.status))result.queued++;else if(['skipped','cancelled'].includes(e.status))result.skipped++;}
  result.uncertain=entries.filter(e=>uncertain.has(e.status)).length;
  result.queued=entries.filter(e=>queued.has(e.status)).length;
  const paused=source.control && (source.control.state==='disabled'||(source.control.state==='paused'&&(!source.control.pausedUntil||new Date(source.control.pausedUntil)>now)));
  if(!source.enabled||paused) return {...result,state:'paused',message:'Disabled or paused in source settings. No missed-send alert.'};
  if(warnings.length) return {...result,state:'unknown',message:'Coverage is incomplete. Review the source warnings.'};
  // Uncertain outcomes remain visible even when older than the latest scheduled run.
  if(entries.some(e=>uncertain.has(e.status))) return {...result,state:'attention',message:'Delivery outcome needs reconciliation. Do not resend until checked.'};
  if(entries.some(e=>queued.has(e.status)&&(!e.at||now.getTime()-new Date(e.at).getTime()>source.queueMinutes*60000))) return {...result,state:'attention',message:'Delivery queue is stuck or has no start time. Check the sender.'};
  if(source.mode==='setup'||source.control?.ready===false) return {...result,state:'setup',message:'Link the expected schedule and responsible owner. Automatic discovery is working.'};
  if(result.failed) return {...result,state:'attention',message:'Failed attempts recorded. Verify recovery before retrying.'};
  if(source.mode==='daily'&&due) {
    if(result.expected===0) return {...result,state:'idle',message:'Run completed with no eligible recipients. Review scope if unexpected.'};
    if(result.expected!==null&&result.accepted<result.expected) return {...result,state:'attention',message:`Incomplete run: ${result.accepted} of ${result.expected} recipient deliveries accepted.`};
    if(!rows.length) return {...result,state:'attention',message:'Expected run is missing after its configured grace period.'};
    if(!result.accepted) return {...result,state:'attention',message:'No accepted deliveries for the expected report date.'};
  }
  if(result.skipped) return {...result,state:'attention',message:'Skipped recipients need review; a successful worker response is not delivery proof.'};
  if(rows.some(e=>!accepted.has(e.status)&&!queued.has(e.status)))return {...result,state:'unknown',message:'Unrecognised delivery outcome. Check the source.'};
  if(result.accepted) return {...result,state:source.owner?'ok':'setup',message:source.owner?(result.expected===null?'Accepted deliveries recorded. Expected recipient coverage is not available.':'Expected recipients accepted by the mail server. Inbox delivery is not confirmed.'):'Deliveries recorded. Assign a responsible owner.'};
  return result;
}
export type Catalog = Record<string, Record<string,{type?:string;format?:string;enum?:string[]}>>;
export function discover(catalog:Catalog):Source[]{
  return Object.entries(catalog).flatMap(([table,cols])=>{
    const statusField=['status','delivery_status','state'].find(k=>cols[k]);
    if(!cols.company_id||!statusField||/(settings|templates|controls|audit|threads)$/.test(table))return [];
    // Discover delivery ledgers by their contract, not a fixed portal list or any email-related table.
    const deliveryName=/(mail|digest|notification)/.test(table)&&/(logs?|attempts|deliveries|scheduled_messages)$/.test(table);
    const deliveryShape=Boolean((cols.recipient_email||cols.recipients)&&(cols.report_date||cols.sent_at||cols.message_id||cols.error_message));
    if(!deliveryName&&!deliveryShape)return [];
    const first=(names:string[])=>names.find(k=>cols[k]);
    const timeField=first(['created_at','started_at','sent_at','completed_at']);
    if(!timeField||!cols.id)return [];
    return [{...base,key:table,table,label:table.replaceAll('_',' '),portal:table.split('_')[0],statusField,timeField,dateField:first(['report_date','sent_on']),recipientField:first(['recipient_email','recipients']),errorField:first(['error_message','error'])}];
  });
}
export function validateSource(s:Source,catalog:Catalog){
  const available=discover(catalog).find(x=>x.table===s.table);
  if(!available)throw new Error('Choose a discovered, company-scoped mail delivery source.');
  if(!s.key||s.key.length>180||!s.label.trim()||s.label.length>160||!s.portal.trim()||s.portal.length>60||s.owner.length>200)throw new Error('Provide a valid name, portal and owner.');
  if(!['daily','event','setup'].includes(s.mode)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))throw new Error('Use a valid schedule and HH:mm time.');
  localParts(new Date(),s.timezone);
  if(!Number.isInteger(s.graceMinutes)||s.graceMinutes<0||s.graceMinutes>360||!Number.isInteger(s.queueMinutes)||s.queueMinutes<5||s.queueMinutes>1440||!Number.isInteger(s.dayOffset)||s.dayOffset>0||s.dayOffset< -7)throw new Error('Grace must be 0–360 minutes, queue age 5–1440, and report offset −7 to 0.');
  if(s.startDate&&!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate))throw new Error('Use YYYY-MM-DD for the first scheduled date.');
}

/** Open the editor with the latest saved rules, preserving server-owned source mapping. */
export function editableSource(source:Source, saved:Partial<Source>):Source {
 return {...source,...saved,key:source.key,table:source.table,statusField:source.statusField,timeField:source.timeField,dateField:source.dateField,recipientField:source.recipientField,errorField:source.errorField,filters:source.filters,control:source.control,settings:source.settings,...(source.control?{mode:source.mode,time:source.time,timezone:source.timezone,dayOffset:source.dayOffset,startDate:source.startDate,endDate:source.endDate}:{}),...(source.settings?.time?{time:source.time}:{})};
}
