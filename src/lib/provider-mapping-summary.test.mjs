import assert from "node:assert/strict";
import test from "node:test";
import {buildProviderMappingSummary, providerMappingSummaryTotals} from "./provider-mapping-summary.ts";

const stations = [
  {id: "qlda", code: "QLDA", name: "Quilandy"},
  {id: "kgqa", code: "KGQA", name: "Kasaragod"}
];
const methods = [{id: "mg", name: "MG per day", componentCodes: ["MG_PER_DAY"]}];
const workers = [
  {id: "worker-ready", dropxId: "QLDA100", fullName: "Ready Person"},
  {id: "worker-pay", dropxId: "QLDA101", fullName: "Pay Missing"}
];

test("station summary separates ready, unmapped and incomplete data", () => {
  const rows = buildProviderMappingSummary({stations, methods, workers,
    sourceMembers: [
      {stationCode: "QLDA", providerMemberId: "A1", providerMemberName: "Ready Person", workDate: "2026-10-27"},
      {stationCode: "QLDA", providerMemberId: "A2", providerMemberName: "Unmapped Person", workDate: "2026-10-27"},
      {stationCode: "QLDA", providerMemberId: "A3", providerMemberName: "Pay Missing", workDate: "2026-10-27"}
    ],
    mappings: [
      {id: "m1", stationId: "qlda", providerMemberId: "A1", workforceId: "worker-ready", paymentMethodId: "mg", paymentValues: {MG_PER_DAY: 800}},
      {id: "m3", stationId: "qlda", providerMemberId: "A3", workforceId: "worker-pay", paymentMethodId: "mg", paymentValues: {}}
    ]
  });
  const qlda = rows.find(row => row.stationId === "qlda");
  assert.deepEqual({total:qlda.total,mapped:qlda.mapped,ready:qlda.ready,unmapped:qlda.unmapped,dataIssues:qlda.dataIssues,completion:qlda.completionPercent},
    {total:3,mapped:2,ready:1,unmapped:1,dataIssues:1,completion:33});
  assert.equal(qlda.details[0].status, "unmapped");
  assert.match(qlda.details.find(detail => detail.providerMemberId === "A3").issues.join(" "), /payment value/);
});

test("saved-only mappings are visible as source-data issues and empty stations remain complete", () => {
  const rows = buildProviderMappingSummary({stations, methods, workers, sourceMembers: [], mappings: [
    {id: "m1", stationId: "qlda", providerMemberId: "A1", workforceId: "worker-ready", paymentMethodId: "mg", paymentValues: {MG_PER_DAY: 800}}
  ]});
  const qlda = rows.find(row => row.stationId === "qlda");
  const kgqa = rows.find(row => row.stationId === "kgqa");
  assert.equal(qlda.details[0].status, "source_missing");
  assert.equal(qlda.dataIssues, 1);
  assert.equal(kgqa.total, 0);
  assert.equal(kgqa.completionPercent, 100);
  assert.deepEqual(providerMappingSummaryTotals(rows), {stations:2,total:1,mapped:1,ready:0,unmapped:0,dataIssues:1,completionPercent:0,profileCompleted:0,profilePending:0,profileReview:0,profileUnknown:1});
});

test("a selected month excludes saved mappings without activity in that month", () => {
  const rows = buildProviderMappingSummary({
    stations: [stations[0]], methods, workers, selectedMonths: ["2026-10"],
    sourceMembers: [{
      stationCode: "QLDA", providerMemberId: "OCT-ACTIVE", providerMemberName: "Ready Person",
      workDate: "2026-10-27", outboundMonths: ["2026-10"], outboundDates: ["2026-10-27"]
    }],
    mappings: [
      {id: "active", stationId: "qlda", providerMemberId: "OCT-ACTIVE", workforceId: "worker-ready", paymentMethodId: "mg", paymentValues: {MG_PER_DAY: 800}, effectiveFrom: "2026-10-01"},
      {id: "inactive", stationId: "qlda", providerMemberId: "PRIOR-MONTH", workforceId: "worker-ready", paymentMethodId: "mg", paymentValues: {MG_PER_DAY: 800}, effectiveFrom: "2026-09-01"}
    ]
  });

  assert.equal(rows[0].total, 1);
  assert.equal(rows[0].ready, 1);
  assert.equal(rows[0].dataIssues, 0);
  assert.deepEqual(rows[0].details.map(detail => detail.providerMemberId), ["OCT-ACTIVE"]);
});

test("newest source and mapping records win deterministically", () => {
  const rows = buildProviderMappingSummary({stations:[stations[0]], methods, workers, sourceMembers:[
    {stationCode:"QLDA",providerMemberId:"A1",providerMemberName:"Old",workDate:"2026-10-01"},
    {stationCode:"QLDA",providerMemberId:"A1",providerMemberName:"Latest",workDate:"2026-10-28"}
  ], mappings:[
    {id:"old",stationId:"qlda",providerMemberId:"A1",effectiveFrom:"2026-01-01"},
    {id:"new",stationId:"qlda",providerMemberId:"A1",effectiveFrom:"2026-10-01",workforceId:"worker-ready",paymentMethodId:"mg",paymentValues:{MG_PER_DAY:800}}
  ]});
  assert.equal(rows[0].details[0].providerMemberName,"Latest");
  assert.equal(rows[0].details[0].status,"ready");
});

test("one-day mappings cover only matching provider activity dates", () => {
  const sourceMembers = [{
    stationCode:"QLDA",providerMemberId:"A1",providerMemberName:"Daily Person",workDate:"2026-10-03",
    outboundMonths:["2026-10"],outboundDates:["2026-10-01","2026-10-02","2026-10-03"]
  }];
  const partial = buildProviderMappingSummary({stations:[stations[0]],methods,workers,sourceMembers,selectedMonths:["2026-10"],mappings:[
    {id:"one-day",stationId:"qlda",providerMemberId:"A1",workforceId:"worker-ready",paymentMethodId:"mg",paymentValues:{MG_PER_DAY:800},effectiveFrom:"2026-10-02",effectiveTo:"2026-10-02",status:"closed"}
  ]});
  assert.equal(partial[0].details[0].status,"partial_coverage");
  assert.equal(partial[0].details[0].coverageLabel,"1/3 active days");
  assert.equal(partial[0].ready,0);
  assert.equal(partial[0].dataIssues,1);

  const exact = buildProviderMappingSummary({stations:[stations[0]],methods,workers,sourceMembers:[{
    ...sourceMembers[0],outboundDates:["2026-10-02"]
  }],selectedMonths:["2026-10"],mappings:[
    {id:"one-day",stationId:"qlda",providerMemberId:"A1",workforceId:"worker-ready",paymentMethodId:"mg",paymentValues:{MG_PER_DAY:800},effectiveFrom:"2026-10-02",effectiveTo:"2026-10-02",status:"closed"}
  ]});
  assert.equal(exact[0].details[0].status,"ready");
  assert.equal(exact[0].details[0].coverageLabel,"1/1 active day");
});


test("profile completion is independent of mapping readiness and distinct by associate", () => {
  const rows = buildProviderMappingSummary({stations,methods,
    workers:[{id:"shared",dropxId:"D1",fullName:"Pending associate",onboardingStatus:"pending"},{id:"done",dropxId:"D2",onboardingStatus:"active"},{id:"review",dropxId:"D3",onboardingStatus:"under_review"}],
    sourceMembers:[{stationCode:"QLDA",providerMemberId:"A"},{stationCode:"QLDA",providerMemberId:"B"},{stationCode:"KGQA",providerMemberId:"C"},{stationCode:"QLDA",providerMemberId:"D"},{stationCode:"QLDA",providerMemberId:"E"}],
    mappings:[["qlda","A","shared"],["qlda","B","shared"],["kgqa","C","shared"],["qlda","D","done"],["qlda","E","review"]].map(([stationId,providerMemberId,workforceId])=>({id:providerMemberId,stationId,providerMemberId,workforceId,paymentMethodId:"mg",paymentValues:{MG_PER_DAY:800}}))
  });
  const qlda=rows.find(r=>r.stationId==="qlda");
  assert.equal(qlda.ready,4,"saved mapping/pay data does not imply completed registration");
  assert.equal(qlda.profilePending,1,"two IDs for one associate count once");
  assert.equal(qlda.profileCompleted,1);assert.equal(qlda.profileReview,1);
  assert.equal(providerMappingSummaryTotals(rows).profilePending,1,"cross-station associate counts once in total");
  assert.equal(qlda.details.find(d=>d.providerMemberId==="A").profiles[0].state,"pending");
});

test("historical mapping periods retain every associated profile in the selected activity", () => {
  const rows=buildProviderMappingSummary({stations:[stations[0]],methods,selectedMonths:["2026-10"],
    workers:[{id:"one",onboardingStatus:"returned"},{id:"two",onboardingStatus:"active"}],
    sourceMembers:[{stationCode:"QLDA",providerMemberId:"A",outboundDates:["2026-10-01","2026-10-02"]}],
    mappings:[{id:"one",stationId:"qlda",providerMemberId:"A",workforceId:"one",effectiveFrom:"2026-10-01",effectiveTo:"2026-10-01"},{id:"two",stationId:"qlda",providerMemberId:"A",workforceId:"two",effectiveFrom:"2026-10-02"}]
  });
  assert.equal(rows[0].profilePending,1);assert.equal(rows[0].profileCompleted,1);
  assert.equal(rows[0].details[0].profiles.length,2);
});
