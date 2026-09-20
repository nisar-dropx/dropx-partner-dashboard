import assert from "node:assert/strict";
import test from "node:test";
import { resolveApprovalAccess, leaveRouteState, readConnectSessionResponse } from "./connect-navigation-state.ts";

const partner = {id:"partner",companyId:"dropx",profileType:"contractor",pageAccess:["dashboard","attendance","wfh"]};
const key = "contractor:dropx:partner";

test("an approver deep link waits for reporting access instead of redirecting", () => {
  assert.equal(resolveApprovalAccess(partner,false,null), "loading");
  assert.equal(resolveApprovalAccess(partner,false,{accountKey:key,status:"loading"}), "loading");
  assert.equal(resolveApprovalAccess(partner,false,{accountKey:key,status:"ready",hasReportees:true}), "allowed");
});
test("a failed reporting check stays retryable and cannot masquerade as denial", () => {
  assert.equal(resolveApprovalAccess(partner,false,{accountKey:key,status:"error"}), "error");
  assert.equal(resolveApprovalAccess(partner,false,{accountKey:key,status:"ready",hasReportees:false}), "denied");
});
test("switching accounts never inherits reporting access from the previous role", () => {
  for (const other of [{...partner,id:"other"},{...partner,companyId:"other"},{...partner,profileType:"employee"}]) {
    assert.equal(resolveApprovalAccess(other,false,{accountKey:key,status:"ready",hasReportees:true}), "loading");
  }
});
test("explicit manager rights remain available; workforce remains excluded", () => {
  assert.equal(resolveApprovalAccess({...partner,profileType:"user"},false,null), "allowed");
  assert.equal(resolveApprovalAccess({...partner,pageAccess:["approvals"]},false,null), "allowed");
  assert.equal(resolveApprovalAccess(partner,true,{accountKey:key,status:"ready",hasReportees:true}), "denied");
});
test("the WFH URL resolves to a rendered Leave screen with WFH selected", () => {
  assert.deepEqual(leaveRouteState("wfh"),{screen:"leave",section:"wfh"});
  assert.deepEqual(leaveRouteState("leave"),{screen:"leave",section:"leave"});
});
test("successful session restoration and explicit signed-out responses stay distinct", async () => {
  assert.deepEqual(await readConnectSessionResponse(Response.json({authenticated:true,accounts:[partner]})),{authenticated:true,accounts:[partner]});
  assert.deepEqual(await readConnectSessionResponse(Response.json({authenticated:false})),{authenticated:false});
  assert.equal((await readConnectSessionResponse(Response.json({authenticated:false},{status:403}))).authenticated,false);
});
test("server errors, malformed responses and HTML do not become a sign-out", async () => {
  for (const response of [Response.json({error:"database unavailable"},{status:500}),Response.json({authenticated:false},{status:503}),Response.json({authenticated:true}),Response.json({}),new Response("<html>upstream error</html>",{status:502})]) {
    await assert.rejects(readConnectSessionResponse(response),/Please retry/);
  }
});
