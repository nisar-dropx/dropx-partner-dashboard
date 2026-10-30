import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBetaWorkforceIdentity} from './beta-workforce-identity.ts';
import {BETA_LIFECYCLE_COMPANY as company,BETA_LIFECYCLE_CANDIDATE as candidate} from './beta-lifecycle.ts';
function fixture(overrides={}) {
 const calls=[];
 const tables={
  workforce_amazon_email_pilot_candidates:[{company_id:company,id:candidate,alias_email:'own@example.test',biometric_id:'500419',station_id:'station',closed_at:null}],
  workforce:[{company_id:company,id:candidate,dropx_id:'DF-test',provider_employee_id:'200001',biometric_id:'500419',location_id:'station',source_profile_type:'canonical',source_profile_id:candidate,deleted_at:null}],
  workforce_amazon_portal_links:[{company_id:company,workforce_id:candidate,transporter_id:'DRIVER',amazon_email:'own@example.test'}],
  field_executive_provider_mappings:[],...overrides};
 const db={from(table){calls.push(table);let rows=tables[table],single=false;const q={select(){return q},eq(k,v){rows=rows.filter(x=>x[k]===v);return q},lte(){return q},or(){return q},maybeSingle(){single=true;return q},then(resolve,reject){return Promise.resolve({data:single?rows[0]??null:rows,error:null}).then(resolve,reject)}};return q;}};
 return {db,calls,tables};
}
test('exact handed-over identity is readable without inventing a pay scheme',async()=>{
 const f=fixture(), result=await loadBetaWorkforceIdentity(f.db,company,candidate);
 assert.equal(result.dropxId,'DF-test');assert.equal(result.providerId,'200001');assert.equal(result.paymentConfigured,false);
});
test('foreign candidate is rejected before any database read',async()=>{
 const f=fixture();assert.equal(await loadBetaWorkforceIdentity(f.db,company,'other'),null);assert.deepEqual(f.calls,[]);
});
test('mismatched email, station, biometric or archived identity cannot expose a link',async()=>{
 for(const change of [{location_id:'other'},{biometric_id:'other'},{deleted_at:'2026-10-01'},{source_profile_id:'other'},{lifecycle_status:'offboarded'},{lifecycle_status:'inactive'}]){
  const f=fixture();Object.assign(f.tables.workforce[0],change);assert.equal(await loadBetaWorkforceIdentity(f.db,company,candidate),null);
 }
 const f=fixture();f.tables.workforce_amazon_portal_links[0].amazon_email='foreign@example.test';assert.equal(await loadBetaWorkforceIdentity(f.db,company,candidate),null);
});
