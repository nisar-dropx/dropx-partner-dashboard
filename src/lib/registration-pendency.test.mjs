import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import * as XLSX from "xlsx";
import {PGlite} from "@electric-sql/pglite";
import {registrationRow,registrationSnapshot,uniqueRegistrationManagerEmail} from "./registration-pendency.ts";
import {buildRegistrationMessages} from "./registration-pendency-digest.ts";
const rules={dropx_one:{enabled:["gender","pincode","ifsc","pf_uan","esi_no","profile_photo","is_handicapped"],required:["gender","pincode","ifsc","pf_uan","esi_no","profile_photo","is_handicapped"]}};
const base={profile:{id:"p1",full_name:"Test <Person>",employee_code:"D001",onboarding_status:"pending",profile_completion_status:"pending",is_active:true,pincode:"100001",ifsc:"IFSC_PRESENT",is_handicapped:false,statutory_applicability:["not_applicable"],created_at:"2026-10-01T00:00:00Z"},profileType:"employee",designation:{name:"Team Lead"},station:{id:"s1",station_code:"TEST1",station_name:"Test station"},categoryRules:rules,date:"2026-10-20"};
test("verified managers may use a personal-domain company login; ambiguous or unsafe addresses are held",()=>{
 assert.equal(uniqueRegistrationManagerEmail(["Manager@gmail.com","manager@gmail.com"]),"manager@gmail.com");
 assert.equal(uniqueRegistrationManagerEmail(["manager@dropxlogistics.com"]),"manager@dropxlogistics.com");
 assert.equal(uniqueRegistrationManagerEmail(["first@gmail.com","second@gmail.com"]),null);
 assert.equal(uniqueRegistrationManagerEmail([null,"not-an-email","x@gmail.com\r\nBcc: other@gmail.com"]),null);
});
test("required completion follows current rule intersection, statutory applicability and employee aliases",()=>{
 const row=registrationRow(base);
 assert.deepEqual(row.missing,["Gender","Photo upload"]);
 assert.equal(row.requiredTotal,5);assert.equal(row.requiredFilled,3);assert.equal(row.ageDays,19);
 assert.equal(row.href,"https://people.dropxlogistics.com/people/p1");
 const restricted=registrationRow({...base,designation:{...base.designation,profile_field_rules:{employees:{dropx_one:{enabled:["gender"],required:["gender"]}}}}});
 assert.deepEqual(restricted.missing,["Gender"]);assert.equal(restricted.requiredTotal,1);
});
test("draft evidence does not count as submission, and old drafts cannot override submitted profiles",()=>{
 const draft={draft_data:{gender:"Female",pincode:""},file_paths:{profile_photo:"saved/draft"},updated_at:"2026-10-20T03:00:00Z"};
 const row=registrationRow({...base,draft});
 assert.equal(row.status,"Draft · not submitted");assert.deepEqual(row.missing,["Pincode"]);
 const submitted=registrationRow({...base,profile:{...base.profile,profile_completion_status:"under_review",gender:"Female",profile_photo_path:"saved/final"},draft});
 assert.equal(submitted.stage,"review");assert.equal(submitted.draftAt,"");assert.deepEqual(submitted.missing,[]);
 assert.match(submitted.action,/do not resubmit/);
});
test("active, offboarded and migrated profiles excluded; operationally inactive Workforce pending still included",()=>{
 assert.equal(registrationRow({...base,profile:{...base.profile,profile_completion_status:"active"}}),null);
 assert.equal(registrationRow({...base,profile:{...base.profile,people_lifecycle_status:"offboarded"}}),null);
 assert.equal(registrationRow({...base,profile:{...base.profile,migration_state:"reclassified"}}),null);
 assert.ok(registrationRow({...base,profileType:"workforce",profile:{...base.profile,is_active:false}}));
});
test("recipient reports have only their own rows; empty recipients are skipped; unmapped rows held",async()=>{
 const first={...registrationRow(base),managerEmail:"one@dropxlogistics.com",managerName:"One"};
 const second={...first,key:"employee:p2",id:"p2",name:"Another employee",managerEmail:"two@dropxlogistics.com",managerName:"Two"};
 const unmapped={...first,key:"employee:p3",id:"p3",managerEmail:"",managerName:""};
 const snapshot=registrationSnapshot("2026-10-20","2026-10-20T04:00:00Z",[first,second,unmapped]);
 assert.equal(snapshot.unrouted.length,1);
 const messages=await buildRegistrationMessages(snapshot,"registration_pendency_morning","Registration | {{month}} {{year}}");
 assert.equal(messages.length,2);assert.deepEqual(messages[0].scope.profileKeys,["employee:p1"]);
 assert.match(messages[0].html,/Morning action list/);assert.doesNotMatch(messages[0].html,/IFSC_PRESENT/);
 assert.match(messages[0].html,/Test station/);
 const book=XLSX.read(Buffer.from(messages[0].attachments[0].content,"base64"));
 const details=XLSX.utils.sheet_to_json(book.Sheets["Registration pendency"]);
 assert.equal(details.length,1);assert.equal(details[0].Name,"Test <Person>");
 assert.equal(details[0]["Missing required fields"],"Gender; Photo upload");
 assert.equal(details[0]["Manager email"],"one@dropxlogistics.com");
 assert.doesNotMatch(JSON.stringify(details),/IFSC_PRESENT|bank_account_no|saved\/final/);
 assert.ok(book.Sheets["Registration pendency"]["!autofilter"]);
 const empty=registrationSnapshot("2026-10-20","2026-10-20T10:30:00Z",[]);
 assert.deepEqual(await buildRegistrationMessages(empty,"registration_pendency_afternoon","Registration | {{month}} {{year}}"),[]);
 const pm=await buildRegistrationMessages(snapshot,"registration_pendency_afternoon","Registration follow-up | {{month}} {{year}}");
 assert.match(pm[0].html,/fresh check/);assert.match(pm[0].attachments[0].filename,/Afternoon/);
});
test("migration is idempotent, installs correct times disabled, and never resets existing controls",async()=>{
 const db=new PGlite();
 try{
  await db.exec("create table companies(id uuid primary key);insert into companies values('43866344-b550-4e8a-9a2d-9d23f3d8a997');create table portal_notification_controls(company_id uuid,portal text,event_key text,state text,paused_until timestamptz,subject_template text,body_template text,config jsonb,unique(company_id,portal,event_key));");
  const sql=await readFile(new URL("../../supabase/migrations/20261020183000_registration_pendency_email_schedule.sql",import.meta.url),"utf8");
  await db.exec(sql);await db.exec(sql);
  const rows=(await db.query("select event_key,state,config from portal_notification_controls order by event_key desc")).rows;
  assert.equal(rows.length,2);assert.equal(rows[0].config.schedule_time,"09:30");assert.equal(rows[1].config.schedule_time,"16:00");
  assert.ok(rows.every(r=>r.state==="disabled"&&r.config.delivery_ready===false&&r.config.day_offset===0&&r.config.send_zero_cases===false));
  await db.exec("update portal_notification_controls set state='paused'");await db.exec(sql);
  assert.equal((await db.query("select count(*)::int as n from portal_notification_controls where state='paused'")).rows[0].n,2);
 }finally{await db.close();}
});
test("worker protects profile-level scope, schedule window and preview never sends",async()=>{
 const worker=await readFile(new URL("./portal-digest-delivery.ts",import.meta.url),"utf8");
 assert.match(worker,/Registration reminder window ended/);
 assert.match(worker,/recipient\.profileKeys\.includes\(key\)/);
 assert.match(worker,/registrationRecipientVerified=true/);
 assert.match(worker,/!registrationRecipientVerified&&!delivery\.recipient_email\.endsWith/);
 const preview=await readFile(new URL("../app/api/ops-pulse/registration-email-preview/route.ts",import.meta.url),"utf8");
 assert.match(preview,/isCompanyOwner\(auth\)/);assert.doesNotMatch(preview,/export async function POST|sendMail|sendEmail/);
});
