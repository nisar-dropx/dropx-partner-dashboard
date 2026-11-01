import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function compile(file,mocks={}){const module={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','exports','module',code)(name=>name in mocks?mocks[name]:name.startsWith('.')?compile(resolve(dirname(file),name.endsWith('.ts')?name:name+'.ts'),mocks):require(name),module.exports,module);return module.exports;}
test('SMTP holds inactive staff, personal mail and revoked scopes; slots share a monthly thread', async()=>{
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const rows=[{key:'wf:1',workspace:'Workforce',stationId:'s1'},{key:'people:2',workspace:'People',stationId:'s1'}];
let email='finance@dropxlogistics.com',eligible=true;
let authorizedKeys=['wf:1'],event='registration_pendency_morning',queuedKeys=['wf:1'];const sent=[];
const recipients=compile('src/lib/registration-mail-recipients.ts');
const delivery=compile('src/lib/portal-digest-delivery.ts',{
 'server-only':{},'./timeout-fetch':{},'./cod-pending-mail-scope':{},'./ops-pulse/cod-pending-data':{},'./adhoc-digest-scope':{},'./id-mapping-digest':{},
 './registration-summary-recipients':{loadRegistrationSummaryRecipients:async()=>[]},
 './registration-pendency-data':{loadRegistrationPendency:async()=>({rows,recipients:[],unrouted:[]})},
 './registration-mail-recipients':{...recipients,loadRegistrationTeamRecipients:async()=>eligible?[{email,name:'Finance',profileKeys:authorizedKeys,audience:'Finance',consolidated:false}]:[]},
 nodemailer:{__esModule:true,default:{createTransport:()=>({sendMail:async options=>{sent.push(options);return {accepted:[email],messageId:options.messageId,response:'TEST ONLY'}},close(){}})}}
});
const threads=[{event_key:'registration_pendency_morning',root_message_id:'<monthly-root@example.com>',last_message_id:'<morning@example.com>',subject:'Registration | November',last_sent_at:date+'T04:00:00Z'},{event_key:'registration_pendency_afternoon',root_message_id:'<old-afternoon-root@example.com>',last_message_id:'<old-afternoon@example.com>',subject:'Old afternoon',last_sent_at:date+'T10:00:00Z'}];
const db={rpc:async name=>name==='portal_finish_digest'?{data:true,error:null}:{data:[{id:'test-delivery',company_id:'test-company',event_key:event,report_date:date,recipient_email:email,subject:'Registration | November',html:'TEST ONLY',body:'TEST ONLY'}],error:null},from(table){const responses={portal_notification_controls:{event_key:event,state:'enabled',config:{delivery_ready:true,timezone:'Asia/Kolkata',schedule_time:'00:00',day_offset:0,email_domain:'dropxlogistics.com'}},email_notification_settings:{is_enabled:true,smtp_host:'test.invalid',smtp_pass:'MOCK',smtp_from:'test@example.com',smtp_port:587},profiles:[{id:'finance'}],portal_digest_threads:threads,portal_digest_deliveries:{scope_summary:{profileKeys:queuedKeys}}};const q=new Proxy({}, {get(_,key){return key==='then'?(resolve)=>resolve({data:responses[table],error:null}):()=>q;}});return q;}};
const run=()=>delivery.deliverPortalDigestQueue(db,'ops',{queued:0,accepted:0,uncertain:0,skipped:0,errors:[]});
const first=await run();assert.equal(first.accepted,1,JSON.stringify(first));
event='registration_pendency_afternoon';const second=await run();assert.equal(second.accepted,1,JSON.stringify(second));
assert.notEqual(sent[0].messageId,sent[1].messageId);assert.equal(sent[0].subject,sent[1].subject);
for(const mail of sent){assert.equal(mail.inReplyTo,'<morning@example.com>');assert.ok(mail.references.includes('<monthly-root@example.com>'));assert.deepEqual(mail.to,['finance@dropxlogistics.com']);}
queuedKeys=['people:2'];assert.equal((await run()).skipped,1);assert.equal(sent.length,2,'Finance People payload never reaches SMTP');
queuedKeys=['wf:1'];authorizedKeys=[];assert.equal((await run()).skipped,1);assert.equal(sent.length,2,'Revoked scope never reaches SMTP');
eligible=false;authorizedKeys=['wf:1'];assert.equal((await run()).skipped,1);assert.equal(sent.length,2,'Offboarded recipient with stale active login never reaches SMTP');
eligible=true;email='personal@gmail.com';assert.equal((await run()).skipped,1);assert.equal(sent.length,2,'Personal email never reaches SMTP');
});
