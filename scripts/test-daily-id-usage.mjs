import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
export async function testDailyIdUsage(
  db,
  { id, company, station, actor, provider },
) {
  const sql = readFileSync(
    "supabase/migrations/20261108173134_daily_id_usage_review.sql",
    "utf8",
  );
  await db.exec(sql);
  await db.exec(sql);
  const worker = id(901),
    owner = id(902),
    method = id(903),
    src = id(904),
    ownSrc = id(905),
    otherStation = id(906),
    date = "2026-10-25";
  const designation = (
    await db.query("select id from designations where code='DA' limit 1")
  ).rows[0].id;
  await db.query(
    "insert into workforce(id,company_id,full_name,dropx_id,designation_id,date_of_join) values($1,$3,'Daily recipient','DAILY1',$4,'2026-10-01'),($2,$3,'Daily owner','DAILY2',$4,'2026-10-01')",
    [worker, owner, company, designation],
  );
  await db.query(
    "insert into payment_method_components(id,company_id,payment_method_id,component_code,component_type,pay_schedule,is_active) values($1,$2,$3,'DELIVERY','production','per_delivery',true)",
    [id(907), company, method],
  );
  for (const [w, member, mid] of [
    [worker, "DAILY-RECIPIENT", id(908)],
    [owner, "DAILY-OWNER", id(909)],
  ])
    await db.query(
      "insert into field_executive_provider_mappings(id,company_id,workforce_id,station_id,provider_id,provider_member_id,payment_method_id,payment_values,effective_from,status) values($1,$2,$3,$4,$5,$6,$7,'{\"DELIVERY\":10}','2026-10-01','active')",
      [mid, company, w, station, provider, member, method],
    );
  for (const [sid, member, count] of [
    [src, "DAILY-OWNER", 100],
    [ownSrc, "DAILY-RECIPIENT", 10],
  ])
    await db.query(
      "insert into cps_shipment_daily(id,company_id,station_code,client,provider_employee_id,work_date,total_delivery,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,assigned_count,delivery_assigned_count,pickup_assigned_count) values($1,$2,'TEST','Amazon',$3,$4,$5,$5,0,0,0,0,$5,$5,0)",
      [sid, company, member, date, count],
    );
  const counts = (n) => ({
    total_delivery: n,
    amazon_delivery: n,
    swa_delivery: 0,
    c_return: 0,
    mfn: 0,
    mfn_return: 0,
    assigned_count: n,
    delivery_assigned_count: n,
    pickup_assigned_count: 0,
  });
  const entry = (version, n = 40) => ({
    workerId: worker,
    stationId: station,
    date,
    decision: "worked",
    version,
    reason: "Confirmed actual daily usage",
    shares: [
      {
        source_shipment_id: src,
        source_counts: counts(100),
        quantities: counts(n),
        owner_worked: true,
      },
    ],
  });
  const save = (e, rpc = "save_daily_id_usage_batch") =>
    db.query(`select public.${rpc}($1,$2,$3) result`, [
      company,
      actor,
      JSON.stringify([e]),
    ]);
  await assert.rejects(
    save(entry(0), "save_workforce_worked_id_batch"),
    /positive fixed/,
    "The exception desk must remain fixed-pay only",
  );
  const reviewCount = (
    await db.query("select count(*)::int n from workforce_worked_id_reviews")
  ).rows[0].n;
  const eventCount = (
    await db.query("select count(*)::int n from workforce_worked_id_events")
  ).rows[0].n;
  await save(entry(0), "validate_daily_id_usage_batch");
  assert.equal(
    (await db.query("select count(*)::int n from workforce_worked_id_reviews"))
      .rows[0].n,
    reviewCount,
    "Preview cannot save a decision",
  );
  assert.equal(
    (await db.query("select count(*)::int n from workforce_worked_id_events"))
      .rows[0].n,
    eventCount,
    "Preview cannot write history",
  );
  await save(entry(0));
  let facts = (
    await db.query(
      "select provider_employee_id,sum(total_delivery)::int n from workforce_payout_shipment_facts where work_date=$1 group by provider_employee_id",
      [date],
    )
  ).rows;
  assert.equal(
    facts.find((r) => r.provider_employee_id === "DAILY-OWNER").n,
    60,
  );
  assert.equal(
    facts.find((r) => r.provider_employee_id === "DAILY-RECIPIENT").n,
    50,
  );
  assert.equal(
    facts.reduce((n, r) => n + r.n, 0),
    110,
    "Reallocation conserves source work, including recipient own deliveries",
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from attendance_daily where workforce_id=$1",
        [worker],
      )
    ).rows[0].n,
    0,
    "Allocating work must not invent fixed-pay attendance",
  );
  await assert.rejects(save(entry(0)), /reviewer changed/);
  await assert.rejects(save(entry(1, 101)), /exceeds/);
  await assert.rejects(
    save({ ...entry(1), decision: "not_worked", shares: [] }),
    /biometric|Deliveries/,
  );
  assert.equal(
    (
      await db.query(
        "select version from workforce_worked_id_reviews where workforce_id=$1",
        [worker],
      )
    ).rows[0].version,
    1,
  );
  await db.query(
    "insert into stations(id,company_id,station_code) values($1,$2,'OTHER')",
    [otherStation, company],
  );
  const payment = (day) =>
    db.query(
      "insert into payment_requests(id,company_id,location_id,status,request_no,adhoc_work_date,adhoc_workforce_id,adhoc_provider_employee_id,adhoc_client) values($1,$2,$3,'paid','CROSS-STATION',$4,$5,'DAILY-OWNER','Amazon')",
      [id(910), company, otherStation, day, owner],
    );
  await assert.rejects(
    payment(date),
    /already allocated/,
    "Ad hoc payment cannot bypass an existing review via another station",
  );
  await payment("2026-10-26");
  await db.query(
    "insert into cps_shipment_daily select (jsonb_populate_record(null::cps_shipment_daily,to_jsonb(d)||jsonb_build_object('id',$1::uuid,'work_date','2026-10-26'))).* from cps_shipment_daily d where id=$2",
    [id(911), src],
  );
  const next = entry(0);
  next.date = "2026-10-26";
  next.shares[0].source_shipment_id = id(911);
  await assert.rejects(
    save(next),
    /ad hoc or finalized payment/,
    "A different payment station must not bypass the owner lock",
  );
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('authenticated','public.save_daily_id_usage_batch(uuid,uuid,jsonb)','execute') ok",
      )
    ).rows[0].ok,
    false,
  );
  assert.equal(
    (await db.query("select current_setting('app.daily_id_usage',true) value"))
      .rows[0].value,
    "",
    "Daily scope must not leak outside its transaction",
  );
  console.log(
    "Daily usage: variable pay, recipient own deliveries, conservation, no invented attendance, stale/overshare rollback, cross-station paid lock and private access passed.",
  );
}
