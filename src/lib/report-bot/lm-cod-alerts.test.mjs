import test from "node:test";
import assert from "node:assert/strict";
import { overdueRemittancesAfterGrace, scrubAlertState, slipReminderState, slipUploadOverdue } from "./lm-cod-alerts.ts";

const at=value=>Date.parse(value+"+05:30");
const row=(created,status="CREATED")=>({id:created,code:"AC1",status,expectedAmount:100,actualAmount:100,variance:0,createdAt:at(created),updatedAt:at(created),submittedAt:status==="SUBMITTED"?at(created):null,createdBy:"station",submittedBy:status==="SUBMITTED"?"station":null});

test("bank alerts wait for pickup end plus thirty minutes",()=>{
  const policy={rule:"Same Day-Complete",start:"18:00",end:"18:30"};
  assert.equal(overdueRemittancesAfterGrace([row("2026-11-11T18:00:00")],null,policy,new Date(at("2026-11-11T18:59:59"))).length,0);
  assert.equal(overdueRemittancesAfterGrace([row("2026-11-11T18:00:00")],null,policy,new Date(at("2026-11-11T19:00:00"))).length,1);
});

test("same-day partial carries post-pickup cash to the next pickup",()=>{
  const policy={rule:"Same Day-Partial",start:"18:00",end:"18:30"};
  const pending=row("2026-11-11T19:00:00");
  assert.equal(overdueRemittancesAfterGrace([pending],null,policy,new Date(at("2026-11-11T23:00:00"))).length,0);
  assert.equal(overdueRemittancesAfterGrace([pending],null,policy,new Date(at("2026-11-12T19:00:00"))).length,1);
});

test("next-day pickup alerts only after its configured close and grace",()=>{
  const policy={rule:"Next Day",start:"10:00",end:"10:30",preparationFrom:"16:00"};
  const pending=row("2026-11-11T21:00:00");
  assert.equal(overdueRemittancesAfterGrace([pending],null,policy,new Date(at("2026-11-12T10:59:59"))).length,0);
  assert.equal(overdueRemittancesAfterGrace([pending],null,policy,new Date(at("2026-11-12T11:00:00"))).length,1);
});

test("slip alert starts thirty minutes after submitted remittance",()=>{
  const submitted=row("2026-11-11T19:00:00","SUBMITTED");
  assert.equal(slipUploadOverdue(submitted,new Date(at("2026-11-11T19:29:59"))),false);
  assert.equal(slipUploadOverdue(submitted,new Date(at("2026-11-11T19:30:00"))),true);
});

test("slip reminder fires after thirty minutes and then hourly, not every half hour",()=>{
  const submitted=row("2026-11-11T20:17:00","SUBMITTED");
  assert.deepEqual(slipReminderState(submitted,new Date(at("2026-11-11T20:47:00"))),{due:true,stage:1,elapsedMinutes:30,submittedAt:at("2026-11-11T20:17:00")});
  assert.equal(slipReminderState(submitted,new Date(at("2026-11-11T21:17:00"))).due,false);
  assert.deepEqual(slipReminderState(submitted,new Date(at("2026-11-11T21:47:00"))),{due:true,stage:2,elapsedMinutes:90,submittedAt:at("2026-11-11T20:17:00")});
  assert.equal(slipReminderState(submitted,new Date(at("2026-11-11T22:17:00"))).due,false);
});

test("scrub deadlines are independent",()=>{
  assert.equal(scrubAlertState("2026-11-11",new Date(at("2026-11-11T13:00:00")),0,0).pending,true);
  assert.equal(scrubAlertState("2026-11-11",new Date(at("2026-11-11T15:00:00")),1,0).pending,false);
  assert.equal(scrubAlertState("2026-11-11",new Date(at("2026-11-11T22:00:00")),1,0).pending,true);
  assert.equal(scrubAlertState("2026-11-11",new Date(at("2026-11-11T22:00:00")),1,1).pending,false);
});
