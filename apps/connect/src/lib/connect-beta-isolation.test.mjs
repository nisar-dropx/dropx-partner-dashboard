import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as profiles from './workforce-profiles.ts';
import { peopleDocumentsAvailable, requiredDropxOnePageCodes } from './dropx-one-pages.ts';

const realRequire = createRequire(import.meta.url);
const mobile = '8086403828';
const normal = (id, designation = 'DA') => ({
  id, company_id: 'company', full_name: id, mobile, mobile_country_code: '91',
  designation_id: designation, designation, dropx_id: id, biometric_id: `bio-${id}`,
  onboarding_status: 'active', lifecycle_status: 'active', is_active: true, deleted_at: null
});
const pilot = (id = 'beta') => ({
  id, company_id: 'company', designation_id: 'DA', full_name: 'Beta candidate', mobile,
  alias_email: 'test.kbwe@example.com', biometric_id: 'beta-bio', status: 'sent', closed_at: null
});
function fixture({ beta = false, pilotError = null, workforce = [normal('ordinary')] } = {}) {
  const reads = [];
  const tables = {
    workforce,
    companies: [{id:'company',name:'DropX',is_active:true}],
    designations: ['DA','DCD','ODCD'].map(id => ({id,company_id:'company',code:id,name:id,is_active:true,
      designation_category_id:'field',onboarding_categories:['workforce'],
      app_page_access:['dashboard','payments','attendance','profile','settings'],
      dropx_one_activation_gate:true,provider_mapping_required:true})),
    designation_categories: [{id:'field',company_id:'company',code:'field',people_module:'workforce',is_active:true}],
    workforce_amazon_pilots: [{company_id:'company',workforce_id:'ordinary',closed_at:null}],
    workforce_amazon_email_pilot_candidates: beta ? [pilot(), {...pilot('closed'),closed_at:'2026-10-01'}, {...pilot('other-mobile'),mobile:'9999999999'}] : []
  };
  const db = {from(table) {
    reads.push(table);
    let rows = [...tables[table] ?? []], single = false;
    const q = {
      select(){return q}, eq(k,v){rows=rows.filter(r=>r[k]===v);return q},
      is(k,v){rows=rows.filter(r=>(r[k]??null)===v);return q},
      in(k,vs){rows=rows.filter(r=>vs.includes(r[k]));return q},
      or(expression){
        rows=rows.filter(r=>expression.split(',').some(part=>{
          const [key,op,...rest]=part.split('.');const value=rest.join('.');
          return op==='is'&&value==='null' ? r[key]==null : String(r[key])===value;
        }));return q;
      },
      order(){return q}, maybeSingle(){single=true;return q},
      then(resolve,reject){return Promise.resolve({data:single?rows[0]??null:rows,error:table==='workforce_amazon_email_pilot_candidates'?pilotError:null}).then(resolve,reject)}
    };
    return q;
  }};
  const mod={exports:{}};
  const mocks={
    'crypto':realRequire('node:crypto'), 'next/headers':{cookies:()=>({get:()=>null})},
    '@/lib/connect-otp':{normalizeMobile: v=>String(v)},
    '@/lib/india-date':{todayInIndia:()=> '2026-10-07'},
    '@/lib/supabase-admin':{supabaseAdmin:db}, '@/lib/workforce-profiles':profiles,
    '@/lib/dropx-one-pages':{peopleDocumentsAvailable,requiredDropxOnePageCodes},
    './connect-wfh-access':{connectWfhEligible:()=>false,loadConnectWfhPolicies:async()=>new Map()},
    './connect-business-trip-access':{connectBusinessTripEligible:()=>false,loadConnectBusinessTripPolicies:async()=>new Map()},
    './connect-preview':{resolveConnectPreview:async()=>null},
    './access-cutoff':{enforceAccessCutoffIfDueForWorker:async()=>true},
    './provider-mapping-policy':{requiresProviderMappingActivation:()=>true},
    '@/lib/partner-onboarding':{
      loadPartnerOnboardingStates:async()=>{reads.push('PARTNER_REPORT');return new Map([['ordinary',{restrict_dropx_one:true,registration_ready:true,mapping_confirmed:false,stage:'bgc_pending',report_date:'2026-09-14'}]])},
      partnerReportStillBlocksWorkspace:()=>true
    }
  };
  const source=readFileSync(process.env.AUTH_REGRESSION_SOURCE || new URL('./connect-auth.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(id=>{assert.ok(id in mocks,`Unexpected dependency ${id}`);return mocks[id]},mod,mod.exports);
  return {...mod.exports,reads,tables};
}
function canonical(account) {
  assert.equal(account.activationOnly,false);
  assert.equal(account.onboardingBeta,false);
  assert.equal(account.activationStage,null);
  assert.ok(account.reference);
  assert.ok(account.pageAccess.includes('earnings'));
  assert.ok(account.pageAccess.includes('attendance'));
}
test('normal DA, DCD and ODCD retain their normal menus regardless of report and legacy pilot flags',async()=>{
  const f=fixture({workforce:[normal('ordinary'),normal('driver','DCD'),normal('own-van','ODCD')]});
  const rows=await f.findConnectAccounts('91',mobile);
  assert.equal(rows.length,3);rows.forEach(canonical);
  assert.ok(!f.reads.includes('PARTNER_REPORT'));
  assert.ok(!f.reads.includes('workforce_amazon_pilots'));
});
test('only the separate open beta ID gets setup access; the same mobile normal profiles are unchanged',async()=>{
  const baseline=await fixture().findConnectAccounts('91',mobile);
  const f=fixture({beta:true});const rows=await f.findConnectAccounts('91',mobile);
  assert.deepEqual(rows.filter(r=>r.id!=='beta'),baseline);
  const beta=rows.find(r=>r.id==='beta');
  assert.equal(beta.activationOnly,true);assert.equal(beta.onboardingBeta,true);
  assert.deepEqual(beta.pageAccess,['activation']);assert.equal(beta.reference,null);
  assert.equal(beta.biometricId,'beta-bio');
  assert.ok(!rows.some(r=>['closed','other-mobile'].includes(r.id)));
});
test('beta storage unavailable never blocks a normal account or changes permissions',async()=>{
  const baseline=await fixture().findConnectAccounts('91',mobile);
  const rows=await fixture({pilotError:{code:'42P01',message:'table unavailable'}}).findConnectAccounts('91',mobile);
  assert.deepEqual(rows,baseline);
});
test('normal pending registration retains its normal status without becoming beta',async()=>{
  const f=fixture({workforce:[{...normal('ordinary'),onboarding_status:'pending'}]});
  const [account]=await f.findConnectAccounts('91',mobile);
  canonical(account);assert.equal(account.status,'Pending');
});
