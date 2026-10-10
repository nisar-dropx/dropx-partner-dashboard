import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadExitNoticeContext, exitEmails, isExitHrRole, exitGrantCoversWorker, resolveExitNoticeRecipients, renderExitNotice } from "./exit-notification-context.ts";

const today = "2026-10-11";
function fixture(contractor = false) {
  const c = row => ({ company_id: "company", ...row });
  return Object.fromEntries(Object.entries({
    hr_exit_cases: [{ id: "case", case_number: "EXIT-TEST", worker_type: contractor ? "contractor" : "employee", employee_id: contractor ? null : "worker", contractor_id: contractor ? "worker" : null, personal_email: "worker@example.com", personal_mobile: "9000000000", status: "submitted", scenario: "resignation", submitted_at: "2026-10-10T16:02:00Z", requested_last_working_date: "2026-11-09", approved_last_working_date: null, notice_days: 30 }],
    employees: [{ id: "worker", employee_code: "D123", full_name: "Example Person", email: "worker@example.com", mobile: "9000000000", location_id: "loc", designation_id: "des" }],
    contractors: [{ id: "worker", dropx_id: "IC123", full_name: "Example Contractor", email: "worker@example.com", location_id: "loc", designation_id: "des" }],
    hr_engagements: [{ id: "eng", person_id: "person", employee_id: contractor ? null : "worker", contractor_id: contractor ? "worker" : null, start_date: "2026-01-01", status: "active" },
      ...[1,2,3].map(n => ({ id: "eng"+n, person_id: "person"+n, status: "active", start_date: "2026-01-01" }))],
    hr_work_assignments: [{id: "a",engagement_id: "eng",location_id:"loc",designation_id:"des",department_id:"dep",org_unit_id:"org",is_primary:true,effective_from:"2026-01-01",effective_to:null},
      ...[1,2,3].map(n=>({id:"a"+n,engagement_id:"eng"+n,effective_from:"2026-01-01",effective_to:null}))],
    hr_reporting_relationships: ["a","a1","a2"].map((id,n)=>({subject_assignment_id:id,manager_assignment_id:"a"+(n+1),relationship_type:"solid_line",is_primary:true,effective_from:"2026-01-01",effective_to:null})),
    hr_user_person_links: [1,2,3].map(n=>({person_id:"person"+n,user_id:"u"+n,status:"active"})),
    hr_people: [1,2,3].map(n=>({id:"person"+n,display_name:"Manager "+n})),
    profiles: [...[1,2,3].map(n=>({id:"u"+n,full_name:"Manager "+n,email:"manager"+n+"@example.com",is_active:true})),
      ...["hr","otherHr","admin","owner","expired","inactive","viewer"].map(id=>({id,full_name:id,email:id+"@example.com",is_active:id!=="inactive",is_master_owner:id==="owner"}))],
    stations:[{id:"loc",station_code:"TEST",station_name:"Test station"}],
    designations:[{id:"des",name:"Team Lead"}],
    hr_org_units:[{id:"org",parent_org_unit_id:"parent"},{id:"parent",parent_org_unit_id:null}],
    hr_roles:[{id:"rh",code:"HRE",is_active:true},{id:"ra",code:"HRMS_ADMIN",is_active:true},{id:"ro",code:"OWNER",is_active:true},{id:"rv",code:"CLM",is_active:true}],
    hr_permission_pages:[{id:"page",code:"exits",is_active:true}],
    hr_role_page_permissions:["rh","ra","ro","rv"].map(role_id=>({role_id,page_id:"page",can_view:true})),
    hr_access_grants:[
      {user_id:"hr",role_id:"rh",scope_type:"location",scope_id:"loc"},
      {user_id:"otherHr",role_id:"rh",scope_type:"location",scope_id:"other"},
      {user_id:"owner",role_id:"ro",scope_type:"company"},
      {user_id:"admin",role_id:"ra",scope_type:"company"},
      {user_id:"viewer",role_id:"rv",scope_type:"company"},
      {user_id:"inactive",role_id:"rh",scope_type:"company"},
      {user_id:"expired",role_id:"rh",scope_type:"company",effective_to:"2026-10-10"}
    ].map(row=>({is_active:true,effective_from:"2026-01-01",effective_to:null,...row}))
  }).map(([name,rows])=>[name,rows.map(c)]));
}

function database(tables, failTable) {
  const calls = [];
  return { calls, from(table) {
    const filters = []; let single = false; let limit = Infinity; let order = null;
    const q = {
      select(){return q}, eq(k,v){filters.push(r=>r[k]===v);return q},
      in(k,v){filters.push(r=>v.includes(r[k]));return q},
      lte(k,v){filters.push(r=>r[k]<=v);return q},
      or(s){const [empty,bounded]=s.split(",");const k=empty.split(".")[0]; const v=bounded.split(".").slice(2).join(".");filters.push(r=>r[k]==null || r[k]>=v);return q},
      order(k,opts){order={k,...opts};return q},limit(n){limit=n;return q},maybeSingle(){single=true;return q},
      then(resolve,reject) {
        calls.push({table,scoped:filters.length>0});
        if(table===failTable)return Promise.resolve({data:null,error:{message:"Lookup unavailable"}}).then(resolve,reject);
        let rows=(tables[table]??[]).filter(r=>filters.every(f=>f(r)));
        if(order)rows=[...rows].sort((a,b)=>String(a[order.k]??"").localeCompare(String(b[order.k]??""))*(order.ascending===false?-1:1));
        rows=rows.slice(0,limit);
        return Promise.resolve({data:single?(rows[0]??null):rows,error:null}).then(resolve,reject);
      }
    }; return q;
  }};
}
const load = (data,failTable) => loadExitNoticeContext(database(data,failTable), "company", "case", {today});

test("current People chain includes exactly the first two managers and scoped HRE, not owners/admins/viewers", async()=>{
 const result=await load(fixture());
 assert.deepEqual(result.groups.REPORTING_MANAGER,["manager1@example.com","manager2@example.com"]);
 assert.deepEqual(result.groups.HR_TEAM,["hr@example.com"]);
 assert.equal(result.values.location,"TEST · Test station");
 assert.equal(result.values.designation,"Team Lead");
 assert.equal(result.values.approved_last_working_date,"Not approved yet");
});
test("contractors resolve their own engagement and code, not an employee id",async()=>{
 const result=await load(fixture(true));
 assert.equal(result.values.employee_code,"IC123");
 assert.deepEqual(result.groups.REPORTING_MANAGER,["manager1@example.com","manager2@example.com"]);
});
test("changed reporting relationship is used immediately",async()=>{
 const data=fixture();data.hr_reporting_relationships[0].manager_assignment_id="a2";
 const result=await load(data);
 assert.deepEqual(result.groups.REPORTING_MANAGER,["manager2@example.com","manager3@example.com"]);
});
test("missing current reporting relationship never adds stale legacy profile managers",async()=>{
 const data=fixture();data.hr_reporting_relationships=[];
 data.profiles.push({company_id:"company",id:"legacy",employee_id:"D123",is_active:true,reports_to_user_id:"owner"});
 const result=await load(data);
 assert.deepEqual(result.groups.REPORTING_MANAGER,[]);
 assert.deepEqual(result.groups.HR_TEAM,["hr@example.com"]);
 assert.match(result.warnings.join(" "),/No current reporting manager/);
});
test("a legacy worker without any engagement can resolve two legacy managers safely",async()=>{
 const data=fixture();data.hr_engagements=[];data.hr_work_assignments=[];
 data.profiles.push({company_id:"company",id:"legacy",employee_id:"D123",is_active:true,reports_to_user_id:"u1"});
 data.profiles[0].reports_to_user_id="u2";
 const result=await load(data);
 assert.deepEqual(result.groups.REPORTING_MANAGER,["manager1@example.com","manager2@example.com"]);
});
test("cycles stop and cannot include the requester or repeat a manager",async()=>{
 const data=fixture();data.hr_reporting_relationships[1].manager_assignment_id="a";
 assert.deepEqual((await load(data)).groups.REPORTING_MANAGER,["manager1@example.com"]);
});
test("inactive or expired managers do not receive an exit notification",async()=>{
 const data=fixture();data.hr_engagements[1].status="inactive";
 assert.deepEqual((await load(data)).groups.REPORTING_MANAGER,[]);
 const second=fixture();second.hr_work_assignments[1].effective_to="2026-10-10";
 assert.deepEqual((await load(second)).groups.REPORTING_MANAGER,[]);
});
test("a missing email does not promote a third manager or email internal identity aliases",async()=>{
 const data=fixture();data.profiles[0].email="mobile@one.connect.dropxlogistics.internal";
 const result=await load(data);
 assert.deepEqual(result.groups.REPORTING_MANAGER,["manager2@example.com"]);
 assert.equal(result.managers.length,2);
 assert.match(result.warnings[0],/manager 1/);
});
test("revoked HR grants, inactive roles and roles without exit permission are excluded",async()=>{
 for(const change of [
  d=>d.hr_access_grants[0].is_active=false,
  d=>d.hr_roles[0].is_active=false,
  d=>d.hr_role_page_permissions[0].can_view=false
 ]){
  const data=fixture();change(data);
  assert.deepEqual((await load(data)).groups.HR_TEAM,[]);
 }
});
test("company isolation applies to the case and scoped recipients",async()=>{
 const data=fixture();data.hr_exit_cases[0].company_id="elsewhere";
 await assert.rejects(load(data),/Exit case is unavailable/);
 const other=fixture();other.hr_access_grants[0].company_id="elsewhere";
 assert.deepEqual((await load(other)).groups.HR_TEAM,[]);
});
test("lookup errors fail closed, never fall back to owners or an empty successful result",async()=>{
 await assert.rejects(load(fixture(),"hr_reporting_relationships"),/Lookup unavailable/);
 await assert.rejects(load(fixture(),"hr_access_grants"),/Lookup unavailable/);
});
test("scopes cover only the right location, department, org ancestry or reporting line",()=>{
 const worker={locationId:"loc",departmentId:"dep",orgUnitIds:["org","parent"],managerUserIds:["u1","u2"],directManagerUserId:"u1"};
 const covers=(scope_type,scope_id,user_id="u2")=>exitGrantCoversWorker({scope_type,scope_id,user_id},worker);
 assert.equal(covers("company",null),true);
 assert.equal(covers("location","other"),false);
 assert.equal(covers("department","dep"),true);
 assert.equal(covers("org_unit","parent"),true);
 assert.equal(covers("reporting_subtree",null),true);
 assert.equal(covers("direct_reports",null),false);
 assert.equal(covers("self",null),false);
});
test("HR roles explicitly exclude system administrators and include real HR short codes",()=>{
 for(const code of ["HRE","HRM","HR_HEAD","HR_EXECUTIVE","HR_MANAGER"])assert.equal(isExitHrRole(code),true);
 for(const code of ["OWNER","HRMS_ADMIN","CLM","TECH"])assert.equal(isExitHrRole(code),false);
});
test("recipients honour configured custom addresses, normalize and dedupe To/CC",()=>{
 const result=resolveExitNoticeRecipients({to_recipients:["REPORTING_MANAGER","HR_TEAM"],cc_recipients:["EMPLOYEE"],custom_to_emails:["Explicit@example.com"],custom_cc_emails:["HR@example.com"]},
 {REPORTING_MANAGER:[" M1@example.com ","m1@example.com"],HR_TEAM:["hr@example.com"],EMPLOYEE:["worker@example.com"]});
 assert.deepEqual(result,{to:["m1@example.com","hr@example.com","explicit@example.com"],cc:["worker@example.com"]});
 assert.deepEqual(exitEmails([null,undefined,"undefined","null","bad","x@one.connect.dropxlogistics.internal"]),[]);
});
test("HTML and plain text show compact complete details and escape all untrusted text",async()=>{
 const context=await load(fixture());context.values.employee_name='<img src=x onerror="alert(1)">';
 const result=renderExitNotice("Request <script>bad()</script>",context);
 for(const text of ["Requested last working day","Approved last working day","Not approved yet","Reporting manager · L2","Test station","Team Lead"])assert.ok(result.body.includes(text));
 assert.ok(result.html.includes("&lt;script&gt;"));
 assert.ok(!result.html.includes("<img"));
 assert.ok(result.body.includes("https://people.dropxlogistics.com/exits/case"));
 assert.ok(result.html.includes("Receiving this email does not change approval ownership"));
});
test("both live entry points use the shared resolver instead of system-owner fanout",()=>{
 const directory=new URL(".",import.meta.url);
 const source=readFileSync(new URL(directory.pathname.includes("/apps/connect/")?"connect-exit-notifications.ts":"exit-notifications.ts",directory),"utf8");
 assert.match(source,/loadExitNoticeContext/); assert.match(source,/renderExitNotice/);
 assert.ok(!source.includes('eq("is_master_owner", true)'));
});
