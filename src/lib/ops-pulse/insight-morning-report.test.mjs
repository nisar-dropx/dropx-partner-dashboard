import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
import {digestThreadEvents} from '../digest-thread-policy.ts';
test('morning insights reuse D−1 builder and retain preview recipient/store restrictions',async()=>{
 const code=ts.transpileModule(readFileSync(new URL('./insight-digest.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let captured;const stations=[{id:'s1',station_code:'TCD4'},{id:'s2',station_code:'TTB3'}];
 const m={exports:{}};new Function('require','module','exports',code)(name=>name==='../amazon-now-digest'?{
 nowDigestEvents:['now_review_digest','now_activity_digest'],loadNowMailScope:async()=>({stations,recipients:[{email:'a@example.com',name:'A',stationIds:['s1','s2']},{email:'b@example.com',name:'B',stationIds:['s2']}]}),
 buildAmazonNowDigest:async(...args)=>{captured=args;return{messages:[]}}
 }:{},m,m.exports);
 const q={select:()=>q,eq:()=>q,in:async()=>({data:[{config:{}}]})};const db={from:()=>q};
 await m.exports.buildInsightDigest(db,{company_id:'c',event_key:'now_insight_morning',subject_template:'Monthly {{month}}',config:{}},'2027-01-01',{email:'a@example.com',stationIds:['s1']});
 assert.equal(captured[1].event_key,'now_activity_digest');assert.equal(captured[1].subject_template,'Monthly {{month}}');assert.equal(captured[2],'2027-01-01');assert.deepEqual(captured[3].recipients.map(r=>[r.email,r.stationIds]),[['a@example.com',['s1']]]);assert.deepEqual(captured[3].stations.map(s=>s.id),['s1']);
});
test('legacy and replacement editions remain in the same monthly thread family',()=>{assert.deepEqual(digestThreadEvents('now_insight_morning'),digestThreadEvents('now_activity_digest'));});
