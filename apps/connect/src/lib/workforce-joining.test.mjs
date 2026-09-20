import test from "node:test";
import assert from "node:assert/strict";
import { invitationName,joiningState,trainingEntitlements,providerInvitationEligibility,belongsToPerson } from "./workforce-joining.ts";
const person={id:"worker",full_name:"Synthetic Trainee",dropx_id:"TEST1",designation_id:"role",location_id:"station",source_profile_type:"field_executive",source_profile_id:"legacy",onboarding_status:"approved",onboarding_approved_at:"2026-08-01T00:00:00Z",lifecycle_status:"onboarding",is_active:false,bank_account_no:"123",ifsc_code:"TEST1"};
const plan={workforce_id:"worker",station_id:"station",mode:"training",eligible_from:"2026-08-01",terms_accepted_on:"2026-08-01",daily_rate:400,minimum_minutes:240,terms_reference:"Accepted terms v1",training_completed_on:null,closed_on:null,provider_stage:"not_started",version:1,updated_at:"2026-08-01T00:00:00Z"};
const day=(date="2026-08-01",changes={})=>({id:date,workforce_id:"worker",field_executive_id:null,contractor_id:null,punch_date:date,in_time:`${date}T03:30:00Z`,out_time:`${date}T11:30:00Z`,work_minutes:480,status:"P",punch_in_location_id:"station",location_id:"station",in_source:null,out_source:null,enrolment_id:"B1",updated_at:`${date}T12:00:00Z`,...changes});
const mapping={id:"map",workforce_id:"worker",provider_member_id:"PROVIDER1",effective_from:"2026-08-07",effective_to:null,status:"active",station_id:"station"};
test("single legal name is retained; invitation can repeat it without inventing a suffix",()=>assert.deepEqual(invitationName(" Peter "),{first_name:"Peter",last_name:"Peter",suffix:"",single_name:true}));
test("canonical attendance identity overrides a conflicting legacy alias",()=>assert.equal(belongsToPerson({workforce_id:"other",field_executive_id:"legacy"},person),false));
const entitlement=(changes={},attendance=[day()],maps=[])=>trainingEntitlements({...person,...changes.person},{...plan,...changes.plan},maps,attendance,"2026-08-01","2026-08-31");
test("approved first biometric arrival starts training without an extra Ops click",()=>assert.equal(joiningState(person,plan,[],[day()],"2026-08-01").stage,"training"));
test("existing active associates are not relabelled as awaiting arrival when mapping is missing",()=>assert.equal(joiningState({...person,is_active:true,onboarding_status:"active",lifecycle_status:"active"},null,[],[],"2026-08-01").stage,"active"));
test("unapproved profiles remain applicants and never earn training",()=>{assert.equal(joiningState({...person,onboarding_status:"under_review"},plan,[],[day()],"2026-08-01").stage,"applicant");assert.equal(entitlement({person:{onboarding_status:"under_review",onboarding_approved_at:null}}).length,0);});
test("two complete distinct days unlock an invitation task, not two punches",()=>{
  assert.equal(providerInvitationEligibility(person,plan,[],[day()],"2026-08-01").eligible,false);
  assert.equal(providerInvitationEligibility(person,plan,[],[day(),day("2026-08-02")],"2026-08-02").eligible,true);
  assert.equal(providerInvitationEligibility(person,plan,[],[day(),day("2026-08-01",{id:"duplicate"})],"2026-08-02").eligible,false);
});
test("mapping entered on 10th but effective 7th pays training only through 6th",()=>{
  const result=entitlement({},[day("2026-08-06"),day("2026-08-07"),day("2026-08-10")],[mapping]);
  assert.deepEqual(result.map(row=>row.attendance.punch_date),["2026-08-06"]);
});
test("direct hires and day-one own-ID hires have no training",()=>{
  assert.equal(entitlement({plan:{mode:"direct",daily_rate:null}}).length,0);
  assert.equal(entitlement({},[day()],[{...mapping,effective_from:"2026-08-01"}]).length,0);
  assert.equal(providerInvitationEligibility(person,{...plan,mode:"direct"},[],[],"2026-08-01").eligible,true);
});
test("closed historical ID never restarts training after ID loss or station transfer",()=>{
  const old={...mapping,effective_from:"2026-07-01",effective_to:"2026-07-31",status:"closed",station_id:"old-station"};
  assert.equal(entitlement({},[day()],[old]).length,0);
  assert.equal(joiningState(person,plan,[old],[day()],"2026-08-01").stage,"awaiting_activation");
});
test("duplicate attendance does not double payment and is held",()=>{
  const result=entitlement({},[day(),day("2026-08-01",{id:"duplicate"})]);
  assert.equal(result.length,1);assert.equal(result[0].amount,400);assert.match(result[0].holds.join(),/Multiple/);
});
for(const [label,changes] of Object.entries({"no checkout":{out_time:null},"too short":{work_minutes:100},"wrong station":{punch_in_location_id:"elsewhere"},"manual entry":{in_source:"business_trip_approved"},"flagged punch":{flagged:true},"non-biometric checkout":{out_source:"manual"}})) {
  test(`${label} is held, not silently paid`,()=>assert.ok(entitlement({},[day("2026-08-01",changes)])[0].holds.length));
}
test("completed training awaiting provider is held for its own pay arrangement",()=>assert.match(entitlement({plan:{training_completed_on:"2026-08-01"}},[day("2026-08-02")])[0].holds.join(),/separate waiting/));
test("early-leaver earnings survive inactivity but stop after last day",()=>{
  const result=entitlement({person:{lifecycle_status:"offboarded",is_active:false,last_working_date:"2026-08-01"}},[day(),day("2026-08-02")]);assert.equal(result.length,1);assert.equal(result[0].amount,400);
});
test("invalid rate holds instead of defaulting to half salary",()=>{for(const rate of [null,0,-1,Infinity]) assert.ok(entitlement({plan:{daily_rate:rate}})[0].holds.length);});
test("an exited associate without an exit date retains earnings for review",()=>{
  const result=entitlement({person:{lifecycle_status:"offboarded",last_working_date:null}});
  assert.equal(result[0].amount,400);assert.match(result[0].holds.join(),/last working date/);
});
test("protected legacy biometric identity resolves but another person does not",()=>{
  assert.equal(belongsToPerson({field_executive_id:"legacy"},person),true);
  assert.equal(belongsToPerson({employee_id:"legacy"},person),false);
  assert.equal(belongsToPerson({workforce_id:"unrelated"},person),false);
});
