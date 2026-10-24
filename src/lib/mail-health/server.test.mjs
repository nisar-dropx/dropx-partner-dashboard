import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as model from './model.ts';
const sourceCode=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
const js=ts.transpileModule(sourceCode,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
function harness({failTable,discoveryFails=false}={}){
 const now=new Date().toISOString(),queries=[];
 const definitions={new_portal_mail_logs:{properties:{id:{},company_id:{},status:{},created_at:{},recipient_email:{}}},broken_mail_logs:{properties:{id:{},company_id:{},status:{},created_at:{}}}};
 const tables={portal_notification_controls:[{company_id:'a',portal:'dashboard',event_key:'mail_health_registry',updated_at:'revision1',config:{version:1,sources:{new_portal_mail_logs:{owner:'Operations',mode:'event'}}}}],people_web_notifications:[],new_portal_mail_logs:[{id:'a1',company_id:'a',status:'sent',created_at:now,recipient_email:'a@example.invalid'},{id:'b1',company_id:'b',status:'sent',created_at:now,recipient_email:'b@example.invalid'}],broken_mail_logs:[]};
 const db={from(table){const filters=[],q={select(fields){q.fields=fields;return q},eq(k,v){filters.push(r=>r[k]===v);if(k==='company_id')q.company=v;return q},gte(k,v){filters.push(r=>r[k]>=v);return q},in(k,vs){filters.push(r=>vs.includes(r[k]));return q},order(){return q},range(a,b){q.start=a;q.end=b;return q},limit(n){q.end=n-1;return q},maybeSingle(){q.single=true;return q},then(resolve,reject){queries.push({table,company:q.company,fields:q.fields});assert.equal(q.company,'a','Every metadata query must be tenant scoped');const data=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).slice(q.start??0,(q.end??9999)+1);return Promise.resolve(table===failTable?{data:null,error:{message:'fixture source unavailable'}}:{data:q.single?data[0]??null:data,error:null}).then(resolve,reject)}};return q;}};
 const mod={exports:{}};
 vm.runInNewContext(js,{exports:mod.exports,module:mod,require(name){if(name==='server-only')return {};if(name==='@/lib/supabase-admin')return {supabaseAdmin:db};if(name==='./model')return model;if(name==='./defaults.json')return {version:1,sources:{}};throw new Error(name);},process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture'}},fetch:async()=>({ok:!discoveryFails,status:503,json:async()=>({definitions})}),AbortSignal,Date,console,Map,Set});
 return {server:mod.exports,queries};
}
test('new table appears automatically and tenant B recipients never leak',async()=>{const h=harness(),snapshot=await h.server.snapshot('a');const source=snapshot.health.find(h=>h.source.table==='new_portal_mail_logs');assert.equal(source.state,'ok');assert.equal(source.entries.length,1);assert.equal(source.entries[0].recipient,'a@example.invalid');assert.ok(h.queries.every(q=>q.company==='a'));assert.ok(h.queries.every(q=>!/(html|body|smtp|secret)/.test(q.fields)));});
test('one failed source does not hide other sources',async()=>{const h=harness({failTable:'broken_mail_logs'}),snapshot=await h.server.snapshot('a');assert.equal(snapshot.health.find(h=>h.source.table==='broken_mail_logs').state,'unknown');assert.equal(snapshot.health.find(h=>h.source.table==='new_portal_mail_logs').state,'ok');});
test('discovery outage explicitly marks coverage unavailable',async()=>{const h=harness({discoveryFails:true}),snapshot=await h.server.snapshot('a');assert.equal(snapshot.health.length,0);assert.ok(snapshot.warnings.some(w=>w.includes('discovery unavailable')));assert.ok(snapshot.warnings.some(w=>w.includes('does not mean all mail is healthy')));});
