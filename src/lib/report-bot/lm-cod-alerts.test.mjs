import test from "node:test";
import assert from "node:assert/strict";
import { bankRemittanceFollowup, observedBankerWindow, overdueRemittancesAfterGrace, prepareDepositAlertState, reconciliationDriverAlert, scrubAlertState, slipReminderState, slipUploadOverdue } from "./lm-cod-alerts.ts";

const at=value=>Date.parse(value+"+05:30");
const row=(created,status="CREATED")=>({id:created,code:"AC1",status,expectedAmount:100,actualAmount:100,variance:0,createdAt:at(created),updatedAt:at(created),submittedAt:status==="SUBMITTED"?at(created):null,createdBy:"station",submittedBy:status==="SUBMITTED"?"station":null});

test("banker window uses last updates, excludes today and respects the seven IST dates",()=>{
  const history=[5,7,10].map((day,index)=>({...row(`2026-11-${String(day).padStart(2,"0")}T20:00:00`,"SUBMITTED"),
    updatedAt:at(`2026-11-${String(day).padStart(2,"0")}T10:${[32,43,58][index]}:00`)}));
  const now=new Date(at("2026-11-12T20:00:00"));
  const result=observedBankerWindow([...history,
    row("2026-11-04T03:00:00","SUBMITTED"),row("2026-11-12T19:00:00","SUBMITTED"),
    row("2026-11-09T23:00:00"),{...row("2026-11-08T22:00:00","SUBMITTED"),updatedAt:null}],now);
  assert.deepEqual(result,{start:"10:30",end:"11:00",sampleDays:3,samples:3,from:"2026-11-05",to:"2026-11-11"});
  assert.equal(observedBankerWindow([history[0],history[0],history[1]],now),null);
  const policy={rule:"Next Day",...result,preparationFrom:"16:00"};
  assert.equal(overdueRemittancesAfterGrace([row("2026-11-11T20:00:00")],null,policy,new Date(at("2026-11-12T11:29:00"))).length,0);
  assert.equal(overdueRemittancesAfterGrace([row("2026-11-11T20:00:00")],null,policy,new Date(at("2026-11-12T11:30:00"))).length,1);
  assert.equal(overdueRemittancesAfterGrace([row("2026-11-12T20:00:00")],null,policy,now).length,0);
});

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

test("DA reconciliation waits 90 minutes, then changes to a full closing sweep at 10 PM",()=>{
  const lastDelivery=at("2026-11-11T18:00:00");
  assert.equal(reconciliationDriverAlert(lastDelivery,new Date(at("2026-11-11T19:29:00"))).due,false);
  assert.equal(reconciliationDriverAlert(lastDelivery,new Date(at("2026-11-11T19:30:00"))).due,true);
  const closing=reconciliationDriverAlert(null,new Date(at("2026-11-11T22:00:00")));
  assert.equal(closing.due,true);
  assert.equal(closing.fullSweep,true);
});

test("Prepare Deposit waits for zero OOR and two hours, then uses the 10 PM closing sweep",()=>{
  const closure=at("2026-11-11T18:00:00");
  assert.equal(prepareDepositAlertState(1,closure,100,new Date(at("2026-11-11T21:00:00"))).due,false);
  assert.equal(prepareDepositAlertState(0,closure,100,new Date(at("2026-11-11T19:59:00"))).due,false);
  assert.equal(prepareDepositAlertState(0,closure,100,new Date(at("2026-11-11T20:00:00"))).due,true);
  assert.equal(prepareDepositAlertState(0,null,100,new Date(at("2026-11-11T22:00:00"))).due,true);
  assert.equal(prepareDepositAlertState(0,null,0,new Date(at("2026-11-11T22:00:00"))).due,false);
});

// A recorded submission must not trigger a missing-banker escalation.
test("bank follow-up escalates only when no submission was updated today",()=>{
  assert.match(bankRemittanceFollowup(false),/call immediately/);
  assert.match(bankRemittanceFollowup(false),/cod-recon@amazon\.com/);
  assert.match(bankRemittanceFollowup(false),/Cluster Manager, CTL, CRM, ct@dropxlogistics\.com and varun@dropxlogistics\.com/);
  assert.doesNotMatch(bankRemittanceFollowup(true),/not arrived|email|cod-recon/);
  assert.match(bankRemittanceFollowup(true),/remaining due amount/);
  assert.doesNotMatch(bankRemittanceFollowup(false),/seven|last.updat/i);
});
