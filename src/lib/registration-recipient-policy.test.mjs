import test from "node:test";
import assert from "node:assert/strict";
import {activeRegistrationStaffUserIds,isDropxRegistrationEmail} from "./registration-recipient-policy.ts";
import {resolveRegistrationTeamRecipients,registrationMailRecipients} from "./registration-mail-recipients.ts";

const source={id:"c",is_active:true,deleted_at:null,people_lifecycle_status:"active"};
const staff={links:[{user_id:"u",person_id:"p",status:"active"}],people:[{id:"p",status:"active"}],engagements:[{person_id:"p",status:"active",start_date:"2026-01-01",end_date:null,contractor_id:"c",employee_id:null,workforce_id:null}],employees:[],contractors:[source],workforce:[]};
test("offboarding source overrides stale active login, person and engagement; only current employment qualifies",()=>{
 const eligible=(overrides={})=>[...activeRegistrationStaffUserIds({...staff,...overrides},"2026-11-02")];
 assert.deepEqual(eligible(),["u"]);
 for(const lifecycle of ["offboarded","offboarding","inactive","suspended",null])assert.deepEqual(eligible({contractors:[{...source,people_lifecycle_status:lifecycle}]}),[]);
 for(const overrides of [{is_active:false},{deleted_at:"2026-10-01"}])assert.deepEqual(eligible({contractors:[{...source,...overrides}]}),[]);
 assert.deepEqual(eligible({engagements:[{...staff.engagements[0],end_date:"2026-11-01"}]}),[]);
 assert.deepEqual(eligible({engagements:[{...staff.engagements[0],start_date:"2026-11-03"}]}),[]);
 assert.deepEqual(eligible({people:[{id:"p",status:"inactive"}]}),[]);
 assert.deepEqual(eligible({links:[...staff.links,{user_id:"u",person_id:"another",status:"active"}]}),[]);
 assert.deepEqual(eligible({contractors:[]}),[]);
});
test("DropX domain restriction blocks personal mail, lookalike domains and header injection",()=>{
 assert.equal(isDropxRegistrationEmail("qlda@dropxlogistics.com"),true);
 for(const email of ["personal@gmail.com","x@dropxlogistics.com.evil.test","x@otherdropxlogistics.com","x@dropxlogistics.com\r\nBcc:a@dropxlogistics.com","a,b@dropxlogistics.com"])assert.equal(isDropxRegistrationEmail(email),false);
});

const profiles=[{id:"location",email:"klza@dropxlogistics.com",full_name:"Location"},{id:"staff",email:"sijith@dropxlogistics.com",full_name:"Manager"},{id:"finance",email:"finance@dropxlogistics.com",full_name:"Finance"}];
const roles=[{id:"loc",code:"OPERATIONS_LOCATION"},{id:"staff",code:"OPERATIONS_STM"},{id:"fin",code:"OPERATIONS_FINMGR"}];
const membership=(user,role,ids)=>({user_id:user,role_id:role,product_code:"operations",location_scope_ids:ids,has_all_location_access:true});
const members=[membership("location","loc",["s1","s2","s3"]),membership("staff","staff",["s1","s2"]),membership("finance","fin",["s1","s2"])];
const station=(id,code,email)=>({id,station_code:code,station_email:email,is_active:true,hide_from_location_list:false});
const stations=[station("s1","KLZA","klza@dropxlogistics.com"),station("s2","KBWE","klza@dropxlogistics.com"),station("s3","OTHER","other@dropxlogistics.com")];
const rows=[{key:"p1",stationId:"s1",workspace:"People"},{key:"w1",stationId:"s1",workspace:"Workforce"},{key:"p2",stationId:"s2",workspace:"People"},{key:"w3",stationId:"s3",workspace:"Workforce"}];
const snapshot={rows,recipients:[{email:"sijith@dropxlogistics.com",name:"Manager",profileKeys:rows.map(r=>r.key)},{email:"personal@gmail.com",name:"Personal",profileKeys:["p1"]}],unrouted:[],date:"2026-11-02",checkedAt:"2026-11-02T04:00:00Z"};
const evidence={stations,activeStaffUserIds:new Set(["staff"])};
const resolve=(changes={})=>resolveRegistrationTeamRecipients(snapshot,changes.profiles||profiles,changes.members||members,roles,{...evidence,...changes});
test("location mail combines mapped stations once, ignores broad access, and replaces individual station manager recipients",()=>{
 const result=registrationMailRecipients(snapshot,[],resolve());
 assert.equal(result.length,1);
 assert.equal(result[0].email,"klza@dropxlogistics.com");
 assert.equal(result[0].audience,"Location");
 assert.deepEqual(result[0].profileKeys,["p1","w1","p2"]);
 assert.equal(result.some(r=>r.email===profiles[1].email),false,"even a corporate station manager email is replaced by location mail");
 assert.equal(result.some(r=>r.email===profiles[2].email),false,"inactive Finance excluded");
 assert.deepEqual(registrationMailRecipients(snapshot),[],"manager metadata cannot silently become recipients");
});
test("missing/revoked mailbox mapping is held, never redirected to personal emails or another station",()=>{
 assert.deepEqual(resolve({stations:[]})[0].profileKeys,[]);
 assert.deepEqual(resolve({stations:stations.map(s=>({...s,is_active:false}))})[0].profileKeys,[]);
 assert.deepEqual(resolve({members:members.map(m=>m.user_id==="location"?{...m,location_scope_ids:["s3"]}:m)})[0].profileKeys,[]);
 assert.deepEqual(resolve({stations:stations.map(s=>({...s,station_email:"personal@gmail.com"}))})[0].profileKeys,[]);
 assert.deepEqual(resolve({profiles:[...profiles,{...profiles[0],id:"duplicate"}]}),[]);
 assert.deepEqual(registrationMailRecipients(snapshot,[{email:"owner@gmail.com",name:"Owner"}],[{email:"person@gmail.com",name:"Person",profileKeys:["p1"],audience:"Ops",consolidated:false}]),[]);
});

test("a mailbox with mixed department and location roles cannot leak People rows to Finance",()=>{
 assert.deepEqual(resolve({members:[...members,membership("location","fin",["s1"])],activeStaffUserIds:new Set(["location","staff"])}),[]);
});
