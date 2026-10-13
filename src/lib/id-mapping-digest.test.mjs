import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildIdMappingDigestMessages, buildMappingDigestSnapshot, resolveMappingDigestRecipients } from "./id-mapping-digest.ts";

const station=(id,code,model="EDSP")=>({id,station_code:code,station_name:code+" Hub",hide_from_location_list:false,providers:{code:"AMAZON"},location_models:{code:model}});
const recipient={email:"manager@dropxlogistics.com",name:"Manager",stationIds:["s1","s2"],roles:["OPERATIONS_AOM"]};
const input={date:"2026-10-14",checkedAt:"2026-10-14T05:30:00Z",stations:[station("s1","AAA"),station("s2","BBB","XPT"),station("now","NOW","NOW")],mappings:[],workforceIds:[],shipments:[
 {station_code:"AAA",provider_employee_id:"100",provider_employee_name:"One",work_date:"2026-10-01",amazon_delivery:1},
 {station_code:"AAA",provider_employee_id:"100",provider_employee_name:"One",work_date:"2026-10-14",amazon_delivery:2},
 {station_code:"BBB",provider_employee_id:"200",provider_employee_name:"Two",work_date:"2026-10-12",amazon_delivery:1},
 {station_code:"NOW",provider_employee_id:"300",provider_employee_name:"Now",work_date:"2026-10-14",amazon_delivery:1}
],recipients:[recipient]};

test("snapshot contains only active EDSP/XPT current-month IDs that remain unmapped",()=>{
 const snapshot=buildMappingDigestSnapshot(input);
 assert.deepEqual(snapshot.rows.map(row=>row.providerId),["100","200"]);
 assert.equal(snapshot.rows[0].ageDays,13);
 assert.equal(snapshot.rows[0].ageBand,">7 days");
 assert.equal(snapshot.recipients[0].pending,2);
 const mapped=buildMappingDigestSnapshot({...input,mappings:[{station_id:"s1",provider_member_id:"100",workforce_id:"w1",status:"active",effective_to:null}],workforceIds:["w1"]});
 assert.deepEqual(mapped.rows.map(row=>row.providerId),["200"]);
});

test("recipient routing uses assigned location scope and excludes location/TL roles",()=>{
 const stations=[station("s1","AAA"),station("s2","BBB")],profiles=[{id:"u1",full_name:"AOM",email:"aom@dropxlogistics.com"},{id:"u2",full_name:"TL",email:"tl@dropxlogistics.com"}];
 const roles=[{id:"r1",code:"OPERATIONS_AOM",location_access_mode:"scoped"},{id:"r2",code:"OPERATIONS_TL",location_access_mode:"scoped"}];
 const memberships=[{user_id:"u1",role_id:"r1",product_code:"operations",has_all_location_access:false,location_scope_ids:["s1"]},{user_id:"u2",role_id:"r2",product_code:"operations",has_all_location_access:false,location_scope_ids:["s1"]}];
 assert.deepEqual(resolveMappingDigestRecipients(stations,memberships,roles,profiles,"dropxlogistics.com",[]),[{email:"aom@dropxlogistics.com",name:"AOM",stationIds:["s1"],roles:["OPERATIONS_AOM"]}]);
});

test("subject is stable while live counts stay in the message and scoped workbook",()=>{
 const snapshot=buildMappingDigestSnapshot(input),subject="OpsPulse | Amazon EDSP + XPT ID mapping | {{month}} {{year}}";
 const first=buildIdMappingDigestMessages(snapshot,subject)[0];
 const smaller=buildIdMappingDigestMessages({...snapshot,rows:snapshot.rows.slice(0,1),recipients:[{...snapshot.recipients[0],pending:1}]},subject)[0];
 assert.equal(first.subject,"OpsPulse | Amazon EDSP + XPT ID mapping | October 2026");
 assert.equal(smaller.subject,first.subject);
 assert.match(first.html,/2 unmapped IDs/);assert.match(smaller.html,/1 unmapped IDs/);
 const workbook=XLSX.read(Buffer.from(first.attachments[0].content,"base64"));
 const detail=XLSX.utils.sheet_to_json(workbook.Sheets["Unmapped IDs"]);
 assert.equal(detail.length,2);assert.deepEqual(new Set(detail.map(row=>row.Station)),new Set(["AAA","BBB"]));
});

test("daily count is rejected when placed in the monthly subject",()=>{
 const snapshot=buildMappingDigestSnapshot(input);
 assert.throws(()=>buildIdMappingDigestMessages(snapshot,"Action today: 2 unmapped IDs | {{month}} {{year}}"),/stable/);
});
