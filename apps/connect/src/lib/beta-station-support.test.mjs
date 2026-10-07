import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {loadBetaStationSupport,supportPhone} from './beta-station-support.ts';

function fixture({closed=false,active=true,email='lead@example.com',phone='9876543210'}={}) {
  const reads=[];
  const tables={workforce_amazon_email_pilot_candidates:[{id:'beta',company_id:'company',station_id:'station',closed_at:closed?'2026-10-01':null}],stations:[{id:'station',company_id:'company',station_code:'KBWE',state:'KL',station_manager_email:email}],profiles:[{company_id:'company',email:'lead@example.com',full_name:'Station Leader',is_active:active,mobile:phone,mobile_country_code:'91'},{company_id:'other',email:'lead@example.com',full_name:'Other Company',is_active:true,mobile:'9999999999'}]};
  const db={from(table){reads.push(table);let rows=[...tables[table]??[]];const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},is(k,v){return q.eq(k,v)},ilike(k,v){rows=rows.filter(r=>r[k].toLowerCase()===v.toLowerCase());return q},async maybeSingle(){return {data:rows.length===1?rows[0]:null,error:rows.length>1?{code:'multiple'}:null}}};return q}};
  return {db,reads};
}
test('support uses only the exact candidate station and active manager in the same company',async()=>{const f=fixture();assert.deepEqual(await loadBetaStationSupport(f.db,'company','beta'),{stationCode:'KBWE',stationState:'KL',leader:{name:'Station Leader',phone:'+919876543210'}});assert.deepEqual(f.reads,['workforce_amazon_email_pilot_candidates','stations','profiles']);});
test('another candidate, another company, and closed beta cannot read station contacts',async()=>{for(const [opts,company,id] of [[{},'other','beta'],[{},'company','other'],[{closed:true},'company','beta']]){const f=fixture(opts);await assert.rejects(()=>loadBetaStationSupport(f.db,company,id));assert.deepEqual(f.reads,['workforce_amazon_email_pilot_candidates']);}});
test('missing or inactive manager never substitutes a different station contact',async()=>{for(const opts of [{active:false},{email:null}])assert.equal((await loadBetaStationSupport(fixture(opts).db,'company','beta')).leader,null);assert.equal((await loadBetaStationSupport(fixture({phone:null}).db,'company','beta')).leader.phone,null);});
test('dial links only accept phone numbers and normalize India mobile country codes',()=>{assert.equal(supportPhone('98765 43210','91'),'+919876543210');assert.equal(supportPhone('+91 (98765) 43210'),'+919876543210');for(const v of ['',null,'123','javascript:alert(1)','+91 9876543210;123','9999ext2'])assert.equal(supportPhone(v),null);});
test('the support API rejects ordinary accounts before reading contact data',async()=>{
 const source=readFileSync(new URL('../../app/api/connect/beta-support/route.ts',import.meta.url),'utf8');
 for(const account of [{workspace:'workforce',onboardingBeta:false},{workspace:'workforce',onboardingBeta:true,activationStage:'legacy'},{workspace:'people',onboardingBeta:true,activationStage:'amazon_email_pilot:x'}]){
  let reads=0;const mod={exports:{}};const mocks={'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},'@/lib/connect-auth':{requireConnectAccount:async()=>account},'@/lib/supabase-admin':{supabaseAdmin:{}},'@/lib/beta-station-support':{loadBetaStationSupport:async()=>{reads++;return {}}}};
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(id=>mocks[id],mod,mod.exports);
  const response=await mod.exports.GET({nextUrl:new URL('https://example.test/?profileType=workforce&accountId=ordinary')});assert.equal(response.status,403);assert.equal(reads,0);
 }
});
