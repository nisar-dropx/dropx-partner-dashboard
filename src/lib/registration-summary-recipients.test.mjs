import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolveRegistrationSummaryRecipients} from "./registration-summary-recipients.ts";
import {registrationSnapshot} from "./registration-pendency.ts";
import {buildRegistrationMessages} from "./registration-pendency-digest.ts";
import * as XLSX from "xlsx";

const owner={id:"owner",email:"owner@example.com",full_name:"Owner",role_id:"owner-role",is_master_owner:false};
const roles=[{id:"owner-role",code:"OWNER"},{id:"manager-role",code:"OPERATIONS_CLM"}];
test("only opted-in current owners receive consolidated reports; product role changes revoke access",()=>{
 assert.deepEqual(resolveRegistrationSummaryRecipients([], [owner],[],roles),[]);
 assert.deepEqual(resolveRegistrationSummaryRecipients([owner.id],[owner],[],roles),[{email:owner.email,name:owner.full_name}]);
 assert.deepEqual(resolveRegistrationSummaryRecipients([owner.id],[owner],[{user_id:owner.id,role_id:"manager-role"}],roles),[]);
 assert.deepEqual(resolveRegistrationSummaryRecipients([owner.id],[{...owner,role_id:"manager-role"}],[],roles),[]);
 assert.deepEqual(resolveRegistrationSummaryRecipients([owner.id],[owner,{...owner,id:"duplicate"}],[],roles),[]);
 assert.deepEqual(resolveRegistrationSummaryRecipients([owner.id],[{...owner,email:"owner@example.com\r\nBcc:bad@example.com"}],[],roles),[]);
});
test("consolidated report includes all pending profiles and routing gaps without widening managers' reports",async()=>{
 const base={key:"employee:1",id:"1",workspace:"People",profileType:"employee",reference:"D1",name:"Person One",designation:"Team Lead",stationId:"s1",stationCode:"TEST1",stationName:"Test station",status:"Registration pending",stage:"pending",missing:["Photo upload"],optionalMissing:[],requiredFilled:1,requiredTotal:2,groups:"",action:"Submit",joinedAt:"",updatedAt:"",draftAt:"",ageDays:3,managerName:"Manager",managerEmail:"manager@example.com",href:"https://people.dropxlogistics.com/people/1"};
 const snapshot=registrationSnapshot("2026-10-24","2026-10-24T04:00:00Z",[base,{...base,key:"workforce:2",id:"2",workspace:"Workforce",stationId:"s2",stationCode:"TEST2",managerName:"",managerEmail:""}]);
 const messages=await buildRegistrationMessages(snapshot,"registration_pendency_morning","Registration | {{month}} {{year}}",[{email:owner.email,name:"Owner"}]);
 const manager=messages.find(m=>m.email===base.managerEmail),summary=messages.find(m=>m.email===owner.email);
 assert.deepEqual(manager.scope.profileKeys,[base.key]);assert.equal(manager.scope.consolidated,false);
 assert.equal(summary.scope.consolidated,true);assert.equal(summary.scope.profileKeys.length,2);
 assert.match(summary.html,/Consolidated/);assert.match(summary.html,/1 profiles have no verified manager email/);
 assert.doesNotMatch(summary.html,/Only profiles assigned to you are included/);
 assert.match(summary.subject,/Consolidated/);
 const book=XLSX.read(Buffer.from(summary.attachments[0].content,"base64"));
 const rows=XLSX.utils.sheet_to_json(book.Sheets["Registration pendency"]);
 assert.equal(rows.length,2);assert.equal(rows[1]["Manager email"],"");
 const noRows=registrationSnapshot(snapshot.date,snapshot.checkedAt,[]);
 assert.deepEqual(await buildRegistrationMessages(noRows,"registration_pendency_afternoon","Registration",[{email:owner.email,name:"Owner"}]),[]);
 const overlapping=await buildRegistrationMessages(snapshot,"registration_pendency_afternoon","Registration",[{email:base.managerEmail,name:"Owner"}]);
 assert.equal(overlapping.length,1);assert.equal(overlapping[0].scope.profileKeys.length,2);
});
test("subscription changes and send-time verification preserve owner authorization",async()=>{
 const actions=await readFile(new URL("../app/settings/notifications/actions.ts",import.meta.url),"utf8");
 assert.match(actions,/!isCompanyOwner\(auth\)\|\|auth.isPreview\|\|auth.readOnly/);
 assert.match(actions,/form.get\('consolidated_summary'\)==='on'\?\[auth.userId\]/);
 const worker=await readFile(new URL("./portal-digest-delivery.ts",import.meta.url),"utf8");
 assert.match(worker,/saved.data.scope_summary\?\.consolidated===true/);
 assert.match(worker,/loadRegistrationSummaryRecipients\(db,delivery.company_id,control.config\)/);
 assert.match(worker,/!currentKeys.has\(key\)/);
});
