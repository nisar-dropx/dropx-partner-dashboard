import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as otp from './beta-amazon-otp.ts';
import { betaJourney } from './beta-journey.ts';

function fixture({accountChange={},closed=false,continuation='continuing',registration='submitted',messageError=false}={}) {
  const account={id:'candidate',companyId:'company',workspace:'workforce',profileType:'workforce',onboardingBeta:true,activationStage:'amazon_email_pilot:sent',...accountChange};
  const reads=[];
  const mail=(candidate_id,company_id,code)=>({id:`${candidate_id}-${company_id}`,candidate_id,company_id,sender:'account-update@amazon.co.uk',subject:'Verify your new Amazon account',preview:`OTP: ${code}`,received_at:new Date().toISOString()});
  const tables={workforce_amazon_email_pilot_candidates:[{id:'candidate',company_id:'company',continuation_status:continuation,closed_at:closed?'2026-10-01':null}],
    workforce_amazon_email_pilot_registrations:[{candidate_id:'candidate',company_id:'company',status:registration}],
    workforce_amazon_email_pilot_messages:[mail('candidate','company','123456'),mail('someone-else','company','999999'),mail('candidate','other-company','888888')]};
  const db={from(table){reads.push(table);assert.ok(table in tables,`Unexpected table ${table}`);let rows=[...tables[table]],single=false;
    const q={select(){return q},eq(k,v){rows=rows.filter(r=>r[k]===v);return q},is(k,v){rows=rows.filter(r=>(r[k]??null)===v);return q},gte(k,v){rows=rows.filter(r=>r[k]>=v);return q},order(){return q},limit(n){rows=rows.slice(0,n);return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve({data:single?rows[0]??null:rows,error:messageError&&table.endsWith('_messages')?{message:'private SQL detail'}:null}).then(resolve,reject)}};return q}};
  const mocks={'next/server':{NextResponse:{json:(body,opts)=>Response.json(body,opts)}},'@/lib/connect-auth':{requireConnectAccount:async(type,id)=>{if(type!==account.profileType||id!==account.id)throw Error('unauthorized');return account}},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/beta-amazon-otp':otp,'@/lib/beta-journey':{betaJourney}};
  const source=fs.readFileSync(new URL('../../app/api/connect/beta-amazon-otp/route.ts',import.meta.url),'utf8');
  const module={exports:{}};new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.ok(id in mocks,id);return mocks[id]},module,module.exports);
  return {GET:module.exports.GET,reads};
}
const request=(id='candidate',type='workforce')=>({nextUrl:new URL(`https://one.example/api/connect/beta-amazon-otp?accountId=${id}&profileType=${type}`)});
test('candidate reads only their company inbox; response is private and contains no raw messages',async()=>{
  const f=fixture();const response=await f.GET(request());assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.latest.code,'123456');assert.equal(body.latest.id,'candidate-company');assert.match(response.headers.get('cache-control'),/private, no-store/);
  assert.equal(response.headers.get('vary'),'Cookie');assert.equal(JSON.stringify(body).includes('preview'),false);
  assert.ok(f.reads.every(table=>table.startsWith('workforce_amazon_email_pilot_')));
});
test('IDOR attempts and canonical/preview accounts cannot reach the private inbox',async()=>{
  const f=fixture();assert.equal((await f.GET(request('someone-else'))).status,401);assert.deepEqual(f.reads,[]);
  for(const accountChange of [{onboardingBeta:false},{readOnlyPreview:true},{activationStage:null},{workspace:'people'}]){
    const denied=fixture({accountChange});assert.equal((await denied.GET(request())).status,403);assert.deepEqual(denied.reads,[]);
  }
});
test('closed, stopped and unregistered candidates do not read messages',async()=>{
  for(const options of [{closed:true},{continuation:'not_continuing'},{registration:'returned'}]){
    const f=fixture(options);assert.equal((await f.GET(request())).status,403);assert.ok(!f.reads.includes('workforce_amazon_email_pilot_messages'));
  }
});
test('inbox failure is retriable, never a false empty state or raw database error',async()=>{
  const response=await fixture({messageError:true}).GET(request());assert.equal(response.status,503);assert.equal(JSON.stringify(await response.json()).includes('private SQL detail'),false);
});
