import test from "node:test";
import assert from "node:assert/strict";
import {inheritsMappingSummaryAccess} from "./mapping-summary-access.ts";
import {mappingProfileState, filterMappingProfiles, mappingProfileWorkspaceLinks} from "./mapping-profile-status.ts";

test("mapping roles and designations inherit only read access on their own surface",()=>{
  for(const granted of ["canView","canAdd","canEdit"]) {
    const permissions={ops_provider_mapping:{canView:false,canAdd:false,canEdit:false,[granted]:true}};
    assert.equal(inheritsMappingSummaryAccess(permissions,"ops_provider_mapping_summary","access"),true);
    assert.equal(inheritsMappingSummaryAccess(permissions,"ops_provider_mapping_summary","view"),true);
    for(const action of ["add","edit"])assert.equal(inheritsMappingSummaryAccess(permissions,"ops_provider_mapping_summary",action),false);
    assert.equal(inheritsMappingSummaryAccess(permissions,"provider_mapping_summary","access"),false);
  }
  assert.equal(inheritsMappingSummaryAccess({},"ops_provider_mapping_summary","access"),false);
  assert.equal(inheritsMappingSummaryAccess({provider_mapping:{canView:true,canAdd:false,canEdit:false}},"provider_mapping_summary","access"),true);
  assert.equal(inheritsMappingSummaryAccess({ops_provider_mapping:{canView:true,canAdd:true,canEdit:true}},"delivery_associates","access"),false);
});
test("profile registration state does not depend on enabled or mapped flags",()=>{
  for(const state of ["pending","returned","rejected"])assert.equal(mappingProfileState(state),"pending");
  for(const state of ["under_review","submitted","approved"])assert.equal(mappingProfileState(state),"review");
  assert.equal(mappingProfileState("active"),"completed");
  for(const state of [null,"","cancelled","new_status"])assert.equal(mappingProfileState(state),"unknown");
});

test("workspace selection intersects authorized rows and current profile state",()=>{
  const rows=[{id:"a",registrationStatus:"pending"},{id:"b",registrationStatus:"active"},{id:"c",registrationStatus:"returned"}];
  assert.deepEqual(filterMappingProfiles(rows,"pending","a,b,outside-scope").map(r=>r.id),["a"]);
  assert.deepEqual(filterMappingProfiles(rows,"pending","").map(r=>r.id),[]);
  assert.deepEqual(filterMappingProfiles(rows,"pending").map(r=>r.id),["a","c"]);
  assert.deepEqual(filterMappingProfiles(rows,"completed","a,b").map(r=>r.id),["b"]);
});

test("large workspace selections preserve every unique associate in bounded links",()=>{
  const ids=Array.from({length:301},(_,i)=>`person-${i}`);
  const links=mappingProfileWorkspaceLinks([...ids,ids[0]],"pending");
  assert.equal(links.length,3);
  assert.deepEqual(links.flatMap(link=>{
    const url=new URL(link.href,"https://ops.example.test");
    assert.equal(url.searchParams.get("section"),"register");
    assert.equal(url.searchParams.get("profile"),"pending");
    const batch=url.searchParams.get("ids").split(",");
    assert.ok(batch.length<=150);
    return batch;
  }),ids);
  assert.deepEqual(mappingProfileWorkspaceLinks([],"pending"),[]);
});
