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
  assert.deepEqual(providerMappingSummaryTotals(rows), {stations:2,total:1,mapped:1,ready:0,unmapped:0,dataIssues:1,completionPercent:0});
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
