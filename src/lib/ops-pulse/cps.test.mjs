import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const module = { exports: {} };
new Function(
  "exports",
  "module",
  ts.transpileModule(
    readFileSync(new URL("./cps.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(module.exports, module);
const { cpsPeriod, cpsView, ratio, summarizeCps, validateCostInput, groupCps } =
  module.exports;
const day = {
  station_code: "A",
  work_date: "2026-09-01",
  deliveries: 100,
  activity: 110,
  associate_rows: 2,
  unmapped: 0,
  unpaid: 0,
  da: 900,
  utr: 100,
  van: 200,
  other: 300,
  rent: 100,
  total: 1500,
  target: 20,
  shipment_present: true,
  utr_configured: true,
  updated_at: null,
};
test("daily, MTD and calendar month have exact date boundaries", () => {
  assert.deepEqual(
    cpsPeriod({ view: "daily", date: "2026-09-08" }, "2026-09-11"),
    {
      mode: "daily",
      date: "2026-09-08",
      month: "2026-09",
      from: "2026-09-08",
      to: "2026-09-08",
      days: 1,
    },
  );
  assert.equal(
    cpsPeriod({ view: "mtd", date: "2026-09-08" }, "2026-09-11").from,
    "2026-09-01",
  );
  assert.equal(
    cpsPeriod({ view: "monthly", month: "2024-02" }, "2026-09-11").to,
    "2024-02-29",
  );
  assert.equal(
    cpsPeriod({ view: "monthly", month: "2026-09" }, "2026-09-11").to,
    "2026-09-11",
  );
  assert.equal(cpsPeriod({}, "2026-10-01").from, "2026-09-01");
});
test("future and malformed dates never drive the latest view", () => {
  for (const date of ["2026-12-07", "2026-02-30", "bad"])
    assert.equal(cpsPeriod({ date }, "2026-09-11").date, "2026-09-10");
  assert.equal(cpsView("__proto__"), "overview");
  assert.equal(cpsView("mtd"), "mtd");
});
test("CPS and target are weighted from numerators, never daily averages", () => {
  const summary = summarizeCps([
    day,
    {
      ...day,
      deliveries: 900,
      total: 27000,
      da: 27000,
      utr: 0,
      van: 0,
      other: 0,
      target: 30,
    },
  ]);
  assert.equal(summary.cps, 28.5);
  assert.equal(summary.target, 29);
  assert.equal(summary.gap, -0.5);
  assert.equal(summary.impact, -500);
});
test("zero denominators and missing targets stay unavailable", () => {
  assert.equal(ratio(100, 0), null);
  assert.equal(summarizeCps([{ ...day, deliveries: 0 }]).cps, null);
  assert.equal(summarizeCps([day, { ...day, target: null }]).target, null);
});
test("missing shipments, missing staff and unmapped pay remain provisional", () => {
  for (const field of [
    { unmapped: 1 },
    { unpaid: 1 },
    { shipment_present: false },
    { utr_configured: false },
  ])
    assert.equal(summarizeCps([{ ...day, ...field }]).provisional, true);
  assert.equal(summarizeCps([day]).provisional, false);
});
test("cost amounts sum once: Other already contains rent", () => {
  const summary = summarizeCps([day]);
  assert.equal(
    summary.total,
    summary.da + summary.utr + summary.van + summary.other,
  );
  assert.equal(summary.total, 1500);
  assert.equal(
    groupCps([day, { ...day, station_code: "B" }], (r) => r.station_code)
      .length,
    2,
  );
});
const input = {
  label: "UTR staff",
  head: "UTR",
  station_codes: "A,B",
  amount: "30000.00",
  frequency: "monthly",
  allocation: "delivery_share",
  effective_from: "2026-09-01",
};
test("cost input requires exact permitted scope and real date", () => {
  assert.deepEqual(validateCostInput(input, ["A", "B"]).station_codes, [
    "A",
    "B",
  ]);
  assert.throws(() => validateCostInput(input, ["A"]), /access/);
  assert.throws(
    () =>
      validateCostInput({ ...input, effective_from: "2026-02-30" }, ["A", "B"]),
    /period/,
  );
  assert.throws(
    () => validateCostInput({ ...input, amount: "" }, ["A", "B"]),
    /amount/,
  );
  assert.throws(
    () => validateCostInput({ ...input, amount: "NaN" }, ["A", "B"]),
    /amount/,
  );
  assert.equal(
    validateCostInput({ ...input, amount: "0" }, ["A", "B"]).amount,
    0,
  );
});
test("cost input preserves zero and disabled status, rejects bad periods", () => {
  assert.equal(
    validateCostInput({ ...input, is_active: false }, ["A", "B"]).is_active,
    false,
  );
  assert.throws(
    () =>
      validateCostInput(
        { ...input, frequency: "once", effective_to: "2026-09-03" },
        ["A", "B"],
      ),
    /One-off/,
  );
  assert.throws(
    () =>
      validateCostInput({ ...input, effective_to: "2026-08-31" }, ["A", "B"]),
    /period/,
  );
});
test('custom periods validate ordering, real dates, future dates and bounded ranges',()=>{
 const p=cpsPeriod({period:'custom',from:'2026-08-20',to:'2026-09-10'},'2026-10-04');
 assert.equal(p.days,22);assert.equal(p.from,'2026-08-20');assert.equal(p.to,'2026-09-10');
 for(const [from,to] of [['2026-10-02','2026-09-01'],['2026-02-30','2026-03-01'],['2026-10-01','2026-10-05'],['2026-01-01','2026-10-01']]) assert.throws(()=>cpsPeriod({period:'custom',from,to},'2026-10-04'));
 assert.deepEqual(module.exports.cpsMonthSlices('2024-02-28','2024-03-02'),[{from:'2024-02-28',to:'2024-02-29'},{from:'2024-03-01',to:'2024-03-02'}]);
});
test('single-station detail cannot include another station costs or issues',()=>{
 const a={...day,station_code:'A'},b={...day,station_code:'B',deliveries:1,total:100000};
 const data={daily:[a,b],breakup:[{station_code:'A',amount:1500},{station_code:'B',amount:100000}],gaps:[{key:'a',station_code:'A'},{key:'b',station_code:'B'}],expense_periods:[{station_code:'B',amount:999}],people:[{station_code:'B',name:'Other DA'}],staff:[{station_code:'B',amount:1234}],vehicles:[{station_code:'B',amount:999}]};
 const single=module.exports.cpsForStation(data,'A');
 assert.equal(summarizeCps(single.daily).cps,15);assert.equal(single.breakup.length,1);assert.equal(single.gaps.length,1);assert.equal(single.expense_periods.length,0);assert.equal(single.people.length,0);assert.equal(single.staff.length,0);assert.equal(single.vehicles.length,0);
 assert.equal(module.exports.cpsForStation(data,'FORGED').daily.length,0);
});
test('cross-month combination sums cost numerators, deduplicates bills and keeps gap dates',()=>{
 const gap={key:'id',station_code:'A',days:1,deliveries:100,known_cost:10,first_date:'2026-08-31',last_date:'2026-08-31'};
 const first={daily:[day],breakup:[],expense_periods:[{source:'payment',source_id:'bill'}],gaps:[gap]};
 const second={daily:[{...day,total:3000,deliveries:50}],breakup:[],expense_periods:first.expense_periods,gaps:[{...gap,first_date:'2026-09-01',last_date:'2026-09-01'}]};
 const data=module.exports.mergeCpsMonths([first,second]);
 assert.equal(summarizeCps(data.daily).cps,30);assert.equal(data.expense_periods.length,1);assert.equal(data.gaps.length,1);assert.equal(data.gaps[0].days,2);assert.equal(data.gaps[0].last_date,'2026-09-01');
});
test('review counts each bill once and retains mapping and unmatched bill issues',()=>{
 const bill={source:'payment',source_id:'bill',station_code:'A',confirmed:false};
 const billingGap={kind:'Billing period unconfirmed',provider_id:'bill',station_code:'A'};
 const mappingGap={kind:'Unmapped',provider_id:'bill',station_code:'A'};
 const otherStation={...billingGap,station_code:'B'};
 const items=module.exports.cpsReviewItems({daily:[],breakup:[],expense_periods:[bill,{...bill,source_id:'confirmed',confirmed:true}],gaps:[billingGap,mappingGap,otherStation]});
 assert.equal(items.count,3);assert.equal(items.bills.length,1);
 assert.deepEqual(items.gaps,[mappingGap,otherStation]);
});
