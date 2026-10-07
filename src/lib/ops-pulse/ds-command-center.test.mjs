import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(path,mocks={}) { const m={exports:{}}; new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m); return m.exports; }
const {summarizeStorePeople,summarizeStoreUnits}=compile('./ds-command-center.ts');
const {isPendingPaymentApproval}=compile('../payment-pending-approval.ts');
const now=Date.parse('2026-10-07T06:00:00Z');
const person=(today={},availability='Not reported')=>({today,availability});
test('future shifts, leave, weekly off and no shift are not marked as missed reporting',()=>{
 const result=summarizeStorePeople([
  person({shiftStartsAt:'2026-10-07T07:00:00Z'}),
  person({shiftStartsAt:'2026-10-07T04:00:00Z',approvedLeave:true},'On leave'),
  person({},'Roster off'), person({}), person({shiftStartsAt:'2026-10-07T04:00:00Z'})
 ],now);
 assert.equal(result.notReported,1);assert.equal(result.due,1);assert.equal(result.upcoming,1);assert.equal(result.leave,1);assert.equal(result.off,1);assert.equal(result.unplanned,1);
});
test('open working shifts only need a punch-out check after their scheduled end',()=>{
 const t={reported:true,missingPunch:true,shiftStartsAt:'2026-10-07T02:00:00Z'};
 const result=summarizeStorePeople([person({...t,shiftEndsAt:'2026-10-07T08:00:00Z'},'Working'),person({...t,shiftEndsAt:'2026-10-07T04:00:00Z'},'Working')],now);
 assert.equal(result.missingOut,1);assert.equal(result.reported,2);assert.equal(result.dueReported,2);
});
test('unit source distinguishes missing from an explicitly entered zero and does not invent hourly data',()=>{
 assert.equal(summarizeStoreUnits(undefined,'2026-10-06').units,null);
 assert.deepEqual(summarizeStoreUnits({units:0,through_date:'2026-10-06'},'2026-10-06'),{units:0,through:'2026-10-06',upd:0,status:'current'});
 assert.equal(summarizeStoreUnits({units:100,through_date:'2026-10-05'},'2026-10-06').status,'behind');
});
test('command center uses queue pending semantics, excluding terminal stages even with retained assignee',()=>{
 for(const status of ['RE_APPROVED','REJECTED','RETURNED','CANCELLED','PROCESSING','PROCESSED'])assert.equal(isPendingPaymentApproval({approval_status:status,current_approver_user_id:'u'}),false);
 for(const status of ['PENDING','RESUBMITTED','RE_PENDING'])assert.equal(isPendingPaymentApproval({approval_status:status}),true);
});
function fixture({permissions=['cpu_overview','ops_rostering'],failUnits=false,failPeople=false}={}) {
 const tables={finance_now_volumes:[{station_code:'DS1',units:80,through_date:'2026-10-06'}],payment_requests:[{id:'lm',location_id:'lm',status:'PENDING',created_at:'2026-10-01',stations:{location_model_id:'lm'}},{id:'ds',location_id:'ds',status:'PENDING',created_at:'2026-10-02',stations:{location_model_id:'ds'}},{id:'processed',location_id:'ds',status:'PROCESSED',created_at:'2026-10-02'}]};
 const calls=[];const db={from:name=>{calls.push(name);const q=new Proxy({data:tables[name]||[],error:name==='finance_now_volumes'&&failUnits?{message:'offline'}:null},{get:(o,k)=>k==='then'?undefined:k in o?o[k]:()=>q});return q;}};
 const helpers=compile('./ds-command-data.ts',{'server-only':{},'@/lib/authorization':{hasPermission:(_a,p)=>permissions.includes(p)},'@/lib/company-scope':{requireCompanyId:()=> 'company'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/supabase-pagination':{readAllRows:async q=>q},'@/lib/payment-approval-scope':{getPaymentApprovalEligibility:async (_c,_a,rows)=>new Set(rows.map(r=>r.id))},'@/lib/payment-pending-approval':{isPendingPaymentApproval},'./rostering':{loadAssignedOpsRosterApprovals:async()=>[{planId:'plan'},{planId:'plan'}]},'./station-manpower':{loadOpsStationManpower:async (_c,locations)=>{assert.deepEqual(locations.map(l=>l.id),['ds']);if(failPeople)throw Error('offline');return {people:[]};}},'./cod':{locationModelName:l=>l.model},'./ds-command-center':{summarizeStorePeople,summarizeStoreUnits}});
 return {helpers,calls};
}
const locations=[{id:'ds',station_code:'DS1',model:'NOW'},{id:'other',station_code:'DS2',model:'NOW'},{id:'lm',model:'EDSP'},{id:'ho',model:'NOW',is_ho:true}];
const auth={hasAllLocationAccess:false,locationScopeIds:['ds','lm','ho']};
test('store reads are restricted to authorized operating DS locations',async()=>{const {helpers}=fixture();const r=await helpers.loadDsCommandData(auth,locations,'2026-10','2026-10-07');assert.deepEqual(r.stores.map(s=>s.code),['DS1']);assert.equal(r.stores[0].units.units,80);});
test('source failures stay unavailable and do not report zero or false absence',async()=>{const {helpers}=fixture({failUnits:true,failPeople:true});const r=await helpers.loadDsCommandData(auth,locations,'2026-10','2026-10-07');assert.equal(r.stores[0].units,null);assert.equal(r.stores[0].people,null);assert(r.unitError&&r.peopleError);});
test('unauthorized unit and manpower sources are not queried',async()=>{const {helpers,calls}=fixture({permissions:[]});const r=await helpers.loadDsCommandData(auth,locations,'2026-10','2026-10-07');assert.deepEqual(calls,[]);assert.equal(r.stores[0].people,null);assert.equal(r.stores[0].units,null);});
test('shared approval actions include LM and DS and roster plans are deduplicated',async()=>{const {helpers}=fixture({permissions:['payment_approvals','ops_rostering']});const r=await helpers.loadDsApprovals(auth);assert.equal(r.payment.count,2);assert.equal(r.rosterCount,1);});
