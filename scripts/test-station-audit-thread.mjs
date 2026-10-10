import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
let rows=[], sequence=0;
const db={from(table){let filters=[],orders=[],op='read',payload;const q={
select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},order(k){orders.push(k);return q},limit(){return q},maybeSingle(){return q},
or(){filters.push(r=>!r.locked_until||new Date(r.locked_until)<new Date());return q},
insert(v){op='insert';payload=v;return q},update(v){op='update';payload=v;return q},
then(done){if(table==='ops_audit_types')return Promise.resolve({data:{id:'stable-type'},error:null}).then(done);
if(op==='insert'){rows.push({id:`row-${++sequence}`,created_at:new Date().toISOString(),...payload});return Promise.resolve({data:null,error:null}).then(done)}
const found=rows.filter(r=>filters.every(f=>f(r))).sort((a,b)=>{for(const k of orders){const n=String(a[k]).localeCompare(String(b[k]));if(n)return n;}return 0})[0]||null;
if(op==='update'&&found)Object.assign(found,payload);
return Promise.resolve({data:found?{...found}:null,error:null}).then(done)}};return q}};
const mod={exports:{}};const mocks={'server-only':{},'node:crypto':{randomUUID:()=>`uuid-${++sequence}`},'@/lib/supabase-admin':{supabaseAdmin:db}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/lib/ops-pulse/station-audit-thread.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>mocks[id],mod,mod.exports);
const acquire=mod.exports.acquireStationAuditThread;
let a=await acquire('company','station','QLDA');
assert.equal(a.subject,'QLDA · Station audit updates');assert.equal(a.inReplyTo,undefined);
await assert.rejects(acquire('company','station','QLDA'),/Another audit email/);
await a.finish(a.messageId);await a.release();const root=a.messageId;
a=await acquire('company','station','QLDA');assert.equal(a.inReplyTo,root);assert.deepEqual(a.references,[root]);await a.finish(a.messageId);await a.release();
const last=a.messageId;a=await acquire('company','station','QLDA');assert.deepEqual(a.references,[root,last]);await a.release();
assert.equal(rows.length,1);assert.equal(rows[0].thread_month,'station');
rows=[{id:'legacy-old',company_id:'company',location_id:'station',created_at:'2026-08-01',audit_type_id:'cod',thread_month:'2026-08',subject:'Original subject',root_message_id:'original-root',last_message_id:'original-last'}, {id:'legacy-new',company_id:'company',location_id:'station',created_at:'2026-10-01',audit_type_id:'physical',thread_month:'2026-10',subject:'Other subject',root_message_id:'other-root',last_message_id:'other-last'}];
a=await acquire('company','station','QLDA');assert.equal(a.subject,'Original subject');assert.equal(a.inReplyTo,'original-last');await a.finish('new-cod-or-physical-reply');await a.release();
a=await acquire('company','station','QLDA');assert.equal(a.inReplyTo,'new-cod-or-physical-reply');assert.deepEqual(a.references,['original-root','new-cod-or-physical-reply']);await a.release();
const other=await acquire('other-company','station','QLDA');assert.equal(other.inReplyTo,undefined);await other.release();
const previous=rows[0].last_message_id; a=await acquire('company','station','QLDA');await a.release();assert.equal(rows[0].last_message_id,previous);
console.log('Station thread tests passed: stable root across months/types, legacy continuity, tenant isolation, send locking and failed-send release.');
