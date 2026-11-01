import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {registrationSnapshot} from "./registration-pendency.ts";
import {resolveRegistrationTeamRecipients,registrationMailRecipients} from "./registration-mail-recipients.ts";
import {buildRegistrationMessages} from "./registration-pendency-digest.ts";
import {digestThreadEvents,selectDigestThread,registrationThreadEvent,registrationMessageSuffix} from "./digest-thread-policy.ts";

const profile=id=>({id,email:`${id}@example.com`,full_name:id});
const profiles=[profile("ops"),profile("hr"),profile("finance"),profile("developer")];
const roles=[{id:"ops",code:"OPERATIONS_CLM"},{id:"hr",code:"PEOPLE_HRM"},{id:"finance",code:"OPERATIONS_FINMGR"},{id:"dev",code:"OPERATIONS_FSD"}];
const grant=(user,role,stations,all=false)=>({user_id:user,role_id:role,product_code:role==="hr"?"people":"operations",location_scope_ids:stations,has_all_location_access:all});
const memberships=[grant("ops","ops",["s1"]),grant("hr","hr",[],true),grant("finance","finance",["s1"]),grant("finance","ops",["s1","s2"]),grant("developer","dev",[],true)];
const base={profileType:"employee",reference:"TEST-1",name:"Example Person",designation:"Team lead",stationName:"Example station",status:"Registration pending",stage:"pending",missing:["Photo upload"],optionalMissing:[],requiredFilled:1,requiredTotal:2,groups:"",action:"Complete photo and submit",joinedAt:"",updatedAt:"",draftAt:"",ageDays:3,managerName:"Ops",managerEmail:"ops@example.com",href:"https://example.com/profile",cluster:"Example cluster",clusterManager:"Example manager"};
const rows=[
 {...base,key:"p1",id:"p1",workspace:"People",stationId:"s1",stationCode:"TEST1"},
 {...base,key:"w1",id:"w1",workspace:"Workforce",stationId:"s1",stationCode:"TEST1"},
 {...base,key:"p2",id:"p2",workspace:"People",stationId:"s2",stationCode:"TEST2",managerEmail:"finance@example.com"},
 {...base,key:"w2",id:"w2",workspace:"Workforce",stationId:"s2",stationCode:"TEST2",managerEmail:"hr@example.com"}
];
const snapshot=registrationSnapshot("2026-11-02","2026-11-02T04:00:00Z",rows);
const teams=()=>resolveRegistrationTeamRecipients(snapshot,profiles,memberships,roles);

test("Finance gets only Workforce, HR only People, Ops both at its locations; technical roles get no report",()=>{
 const recipients=registrationMailRecipients(snapshot,[],teams());
 assert.deepEqual(recipients.find(r=>r.email==="ops@example.com").profileKeys,["p1","w1"]);
 assert.deepEqual(recipients.find(r=>r.email==="hr@example.com").profileKeys,["p1","p2"]);
 assert.deepEqual(recipients.find(r=>r.email==="finance@example.com").profileKeys,["w1"]);
 assert.equal(recipients.some(r=>r.email==="developer@example.com"),false);
 assert.equal(new Set(recipients.map(r=>r.email)).size,recipients.length);
});
test("revoked departmental station scope stays empty and cannot fall back to direct-report routing",async()=>{
 const revoked=resolveRegistrationTeamRecipients(snapshot,profiles,memberships.map(m=>m.user_id==="finance"?{...m,location_scope_ids:[]}:m),roles);
 const messages=await buildRegistrationMessages(snapshot,"registration_pendency_morning","Registration | {{month}} {{year}}",[],revoked);
 assert.equal(messages.some(m=>m.email==="finance@example.com"),false);
 const allowed=registrationMailRecipients(snapshot,[],revoked).find(r=>r.email==="finance@example.com");
 assert.equal(allowed.profileKeys.includes("w1"),false,"a previously queued Workforce row is now unauthorized");
});
test("shared addresses cannot inherit a direct manager's private report",()=>{
 const shared=resolveRegistrationTeamRecipients(snapshot,[...profiles,{...profile("duplicate"),email:"finance@example.com"}],memberships,roles);
 assert.deepEqual(registrationMailRecipients(snapshot,[],shared).find(r=>r.email==="finance@example.com").profileKeys,[]);
});
test("body, Excel and recorded scope use the same recipient-specific data and include cluster and missing fields",async()=>{
 const subject="DropX | Registration pendency | {{month}} {{year}}";
 const messages=await buildRegistrationMessages(snapshot,"registration_pendency_morning",subject,[],teams());
 const pm=await buildRegistrationMessages(snapshot,"registration_pendency_afternoon",subject,[],teams());
 for(const message of messages){
  assert.equal(message.subject,pm.find(m=>m.email===message.email).subject);
  const book=XLSX.read(Buffer.from(message.attachments[0].content,"base64"));
  const sheet=book.Sheets["Registration pendency"],detail=XLSX.utils.sheet_to_json(sheet);
  assert.equal(detail.length,message.scope.pending);
  assert.ok(sheet["!autofilter"]);
  assert.ok(detail.every(r=>r.Cluster==="Example cluster"&&r["Cluster manager"]==="Example manager"&&r["Missing required fields"]==="Photo upload"));
  if(message.scope.audience==="Finance"){
   assert.ok(detail.every(r=>r.Workspace==="Workforce"));
   assert.doesNotMatch(message.html,/Open People/);
  }
  if(message.scope.audience==="HR"){
   assert.ok(detail.every(r=>r.Workspace==="People"));
   assert.doesNotMatch(message.html,/Open Workforce/);
  }
  assert.match(message.text,/No longer active: verify and initiate offboarding/);
 }
 const empty=registrationSnapshot(snapshot.date,snapshot.checkedAt,[]);
 assert.deepEqual(await buildRegistrationMessages(empty,"registration_pendency_afternoon",subject,[],teams()),[]);
});
test("morning/afternoon have unique message IDs in one monthly thread, including first-send afternoon and legacy roots",()=>{
 const am="registration_pendency_morning",pm="registration_pendency_afternoon";
 assert.deepEqual(digestThreadEvents(am),digestThreadEvents(pm));
 assert.equal(registrationThreadEvent(am),registrationThreadEvent(pm));
 assert.notEqual(registrationMessageSuffix(am),registrationMessageSuffix(pm));
 const morning={event_key:am,root_message_id:"root-a",last_sent_at:"2026-11-01T04:00:00Z"};
 const oldAfternoon={event_key:pm,root_message_id:"old-root-b",last_sent_at:"2026-11-01T10:30:00Z"};
 assert.equal(selectDigestThread(pm,[oldAfternoon,morning]),morning);
 const afternoon={...oldAfternoon,root_message_id:"root-a"};
 assert.equal(selectDigestThread(am,[morning,afternoon]),afternoon);
 assert.equal(selectDigestThread(am,[afternoon]),afternoon);
 assert.equal(selectDigestThread(am,[]),null,"next month starts a fresh root");
 assert.equal(selectDigestThread("review_digest",[morning,oldAfternoon]),oldAfternoon);
});
