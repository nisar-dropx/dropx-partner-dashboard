import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(file){const m={exports:{}};new Function('exports','module',ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports,m);return m.exports;}
const {createReportCache}=compile('./report-cache.ts');
const {createRefreshGate}=compile('./refresh-gate.ts');
test('concurrent exact-scope requests share one load; other users/scopes/dates do not',async()=>{
 let time=0,calls=0,release;const read=createReportCache({now:()=>time});
 const load=()=>{calls++;return new Promise(resolve=>release=resolve);};
 const a=read('user1/A/oct',load),b=read('user1/A/oct',load);await Promise.resolve();assert.equal(calls,1);release('A');
 assert.deepEqual(await a,await b);await read('user1/A/oct',load);assert.equal(calls,1);
 for(const key of ['user2/A/oct','user1/B/oct','user1/A/sep'])assert.equal((await read(key,async()=>key)).value,key);
 time=10001;assert.equal((await read('user1/A/oct',async()=>'new')).value,'new');
});
test('failed refresh retains a labelled success for at most five minutes, never extends its age',async()=>{
 let time=0;const read=createReportCache({now:()=>time});const fail=()=>{throw Error('timeout');};
 await read('A',async()=>42);time=20000;const stale=await read('A',fail);
 assert.equal(stale.value,42);assert.equal(stale.refreshDelayed,true);assert.equal(stale.refreshedAt,0);
 time=300001;await assert.rejects(read('A',fail),/timeout/);
 assert.equal((await read('A',async()=>45)).refreshDelayed,false);
});
test('initial failures are never cached; retention is bounded',async()=>{
 const read=createReportCache({maxEntries:2});await assert.rejects(read('A',()=>{throw Error('offline');}));
 assert.equal((await read('A',async()=>1)).value,1);
 await read('B',async()=>2);await read('C',async()=>3);
 assert.equal((await read('A',async()=>4)).value,4);
});
test('tab changes, timers and repeated clicks cannot overlap an in-flight refresh',()=>{
 let time=0;const gate=createRefreshGate(()=>time);
 assert.equal(gate.start(),false);time=60000;assert.equal(gate.start(),true);
 time=180000;assert.equal(gate.start(),false);assert.equal(gate.start(true),false);
 gate.finish();assert.equal(gate.start(),false);time=240000;assert.equal(gate.start(),true);
 gate.finish();assert.equal(gate.start(true),true);
});
