import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function harness({readOnly=false,permission=true,existing=null,loadError=false,sendError=false,reserveError=false}={}){
 const state={sends:[],writes:[],snapshots:0};
 const db={from(table){let operation='read',payload,filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},gte(){return q},order(){return q},limit(){return q},insert(v){operation='insert';payload=v;return q},update(v){operation='update';payload=v;return q},single(){return q},maybeSingle(){return q},then(resolve){let result={data:null,error:null};if(operation!=='read'){state.writes.push({table,operation,payload});result=reserveError&&table==='portal_digest_runs'?{data:null,error:{message:'duplicate'}}:{data:{id:table==='portal_digest_runs'?'run':'delivery'},error:null};}else if(table==='email_notification_settings')result.data={is_enabled:true,smtp_host:'smtp.example'};else if(table==='portal_digest_deliveries'&&!filters.some(([k])=>k==='status'))result.data=existing;return Promise.resolve(result).then(resolve)}};return q}};
 const mocks={
 '@/lib/authorization':{getAuthorization:async()=>({readOnly,email:'OWNER@example.com',userId:'u',fullName:'Owner'}),hasPermission:()=>permission},
 '@/lib/company-scope':{requireCompanyId:()=> 'company'},
 '@/lib/portal-digest-delivery':{digestDatabase:()=>db},
 '@/lib/portal-digest-attachments':{digestMailAttachments:x=>x},
 '@/lib/loss-daily-data':{loadLossDailySnapshot:async()=>{state.snapshots++;if(loadError)throw Error('Source unavailable');return {date:'2026-10-24',checkedAt:'now',stations:[],scopeCount:1,actions:[]}}},
 '@/lib/loss-daily-mail':{lossEscape:x=>String(x||''),buildLossDailyMail:()=>({subject:'Monthly report',html:'<body>current report</body>',text:'current report',filename:'OpsPulse-Loss-Actions-2026-10-24.xlsx',workbook:Buffer.from('xlsx')})},
 '@/lib/email':{sendEmail:async x=>{state.sends.push(x);if(sendError)throw Error('SMTP timeout');return {accepted:['owner@example.com'],messageId:'receipt',response:'250 accepted'}}}
 };
 const m={exports:{}};new Function('require','module','exports',ts.transpileModule(readFileSync(new URL('./route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>mocks[n],m,m.exports);
 return {state,...m.exports};
}
const request=()=>new Request('https://ops.dropxlogistics.com/api/ops-pulse/loss-recovery-digest-preview?to=other@example.com',{method:'POST',headers:{origin:'https://ops.dropxlogistics.com'}});
test('manual send only targets signed-in email; logs attachment and SMTP acceptance without scheduling',async()=>{const h=harness();const r=await h.POST(request());assert.equal(r.status,200);assert.deepEqual(h.state.sends[0].to,['owner@example.com']);assert.equal(h.state.sends[0].attachments.length,1);assert.ok(h.state.writes.every(w=>['portal_digest_runs','portal_digest_deliveries'].includes(w.table)));assert.equal(h.state.writes.at(-1).payload.status,'accepted');});
test('accepted duplicate is not sent or rebuilt',async()=>{const h=harness({existing:{status:'accepted',message_id:'old'}});assert.equal((await h.POST(request())).status,200);assert.equal(h.state.sends.length,0);assert.equal(h.state.snapshots,0);});
test('race reservation and incomplete source both fail closed',async()=>{for(const opts of [{reserveError:true},{loadError:true}]){const h=harness(opts);assert.equal((await h.POST(request())).status,400);assert.equal(h.state.sends.length,0);}});
test('uncertain SMTP send is persisted and never automatically retried',async()=>{const h=harness({sendError:true});assert.equal((await h.POST(request())).status,400);assert.equal(h.state.sends.length,1);assert.equal(h.state.writes.at(-1).payload.status,'uncertain');const retry=harness({existing:{status:'uncertain'}});await retry.POST(request());assert.equal(retry.state.sends.length,0);});
test('impersonation, missing permissions and cross-origin calls cannot send',async()=>{for(const opts of [{readOnly:true},{permission:false}]){const h=harness(opts);assert.equal((await h.POST(request())).status,400);assert.equal(h.state.sends.length,0);}const h=harness();assert.equal((await h.POST(new Request(request(),{headers:{origin:'https://evil.example'}}))).status,403);assert.equal(h.state.sends.length,0);});
test('preview builds current own-scope report without sending',async()=>{const h=harness();const r=await h.GET(new Request('https://ops.dropxlogistics.com/api/ops-pulse/loss-recovery-digest-preview?date=2025-01-01'));assert.match(await r.text(),/owner@example.com/);assert.equal(h.state.sends.length,0);assert.equal(h.state.writes.length,0);});
