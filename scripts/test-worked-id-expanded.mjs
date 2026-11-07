import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { directPayForDay } from "../src/lib/direct-workforce-pay.ts";
export async function testExpandedWorkedReview(
  db,
  {
    id,
    company,
    station,
    worker,
    owner,
    third,
    actor,
    source,
    method,
    date,
    share,
  },
) {
  await db.exec(
    "create table if not exists designations(id uuid primary key,company_id uuid,code text,name text)",
  );
  await db.query(
    "insert into designations values($1,$2,'DA','Delivery Associate'),($3,$2,'SRTR','Sorter')",
    [id(201), company, id(202)],
  );
  await db.query(
    "update workforce set designation_id=$1,created_at='2026-10-01 00:00+00',dropx_id=id::text",
    [id(201)],
  );
  await db.query(
    "update payment_method_components set component_code='MG_PER_DAY' where payment_method_id=$1",
    [method],
  );
  await db.query(
    "update field_executive_provider_mappings set payment_values='{\"MG_PER_DAY\":1000}'",
  );
  await db.exec("delete from workforce_payout_attendance_values");
  const sql = readFileSync(
    "supabase/migrations/20261107074253_worked_id_bulk_training_and_absent_owner.sql",
    "utf8",
  );
  await db.exec(sql);
  await db.exec(sql);
  const batch = (entries, who = actor) =>
    db.query("select save_workforce_worked_id_batch($1,$2,$3) result", [
      company,
      who,
      JSON.stringify(entries),
    ]);
  const entry = (decision, version, day = date, extra = {}) => ({
    workerId: worker,
    stationId: station,
    date: day,
    decision,
    version,
    reason: "Confirmed with station evidence",
    ...extra,
  });
  await batch([entry("worked", 4, date, { shares: [share(100, 120, false)] })]);
  const ownerDay = (
    await db.query(
      "select * from workforce_payout_attendance_facts where workforce_id=$1 and punch_date=$2",
      [owner, date],
    )
  ).rows[0];
  assert.equal(ownerDay.status, "A");
  assert.equal(ownerDay.work_minutes, 0);
  assert.equal(ownerDay.in_time, null);
  assert.equal(
    (
      await db.query(
        "select status from attendance_daily where workforce_id=$1 and punch_date=$2",
        [owner, date],
      )
    ).rows[0].status,
    "P",
  );
  const components = [
    {
      component_code: "MG_PER_DAY",
      component_type: "amount",
      pay_schedule: "per_day",
      calculation_source: "attendance_eligibility",
      calculation_type: "fixed_daily",
      label: "MG",
    },
  ];
  const absentPay = directPayForDay(
    { MG_PER_DAY: 1000 },
    components,
    date,
    ownerDay,
  );
  assert.equal(absentPay.total, 0, "Absent ID owner must not receive daily MG");
  const monthlyComponents = [
    {
      ...components[0],
      component_code: "MG_PER_MONTH",
      pay_schedule: "per_month",
      calculation_type: "fixed_monthly",
    },
  ];
  assert.equal(
    directPayForDay({ MG_PER_MONTH: 26000 }, monthlyComponents, date, ownerDay)
      .total,
    0,
    "Absent ID owner must not accrue monthly MG",
  );
  await assert.rejects(
    db.query("update cps_shipment_daily set total_delivery=121 where id=$1", [
      source,
    ]),
    /owner|review|reopen/i,
    "Later source imports cannot silently recreate absent-owner pay",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select total_delivery from workforce_payout_shipment_facts where provider_employee_id='OWNER'",
        )
      ).rows[0].total_delivery,
    ),
    0,
  );
  await batch([entry("reopened", 5)]);
  const restored = (
    await db.query(
      "select * from workforce_payout_attendance_facts where workforce_id=$1 and punch_date=$2",
      [owner, date],
    )
  ).rows[0];
  assert.equal(restored.status, "P");
  assert.ok(
    directPayForDay({ MG_PER_MONTH: 26000 }, monthlyComponents, date, restored)
      .total > 0,
  );
  assert.equal(
    directPayForDay({ MG_PER_DAY: 1000 }, components, date, restored).total,
    1000,
  );
  // Variable-only, van-rent-only and non-delivery profiles cannot use this desk.
  await db.query("update workforce set designation_id=$1 where id=$2", [
    id(202),
    worker,
  ]);
  await assert.rejects(batch([entry("not_worked", 6)]), /Only DA/);
  await db.query("update workforce set designation_id=$1 where id=$2", [
    id(201),
    worker,
  ]);
  await db.query(
    'update field_executive_provider_mappings set payment_values=\'{"MG_PER_DAY":0,"VAN_RENT_PER_DAY":500}\' where workforce_id=$1',
    [worker],
  );
  await assert.rejects(batch([entry("not_worked", 6)]), /Only DA/);
  await db.query(
    "update field_executive_provider_mappings set payment_values='{\"MG_PER_DAY\":1000}' where workforce_id=$1",
    [worker],
  );
  const manager = id(203),
    training = (version, day = date, src = source) =>
      entry("training", version, day, {
        buddySourceId: src,
        approverIds: [manager],
        approverNames: ["Cluster Manager"],
      });
  await assert.rejects(batch([training(6)], manager), /different Cluster/);
  await db.query(
    "update workforce set created_at='2026-09-30 10:00+00' where id=$1",
    [worker],
  );
  await assert.rejects(batch([training(6)]), /registration month/);
  await db.query(
    "update workforce set created_at='2026-10-16 10:00+00' where id=$1",
    [worker],
  );
  await assert.rejects(batch([training(6)]), /registration/);
  await db.query(
    "update workforce set created_at='2026-10-01 10:00+00' where id=$1",
    [worker],
  );
  await batch([training(6)]);
  assert.equal(
    (
      await db.query(
        "select status from workforce_payout_attendance_facts where workforce_id=$1 and punch_date=$2",
        [worker, date],
      )
    ).rows[0].status,
    "A",
    "Pending training is unpaid",
  );
  await assert.rejects(
    batch([entry("approve_training", 7)]),
    /assigned Cluster/,
  );
  await assert.rejects(batch([entry("reopened", 7)]), /cannot be reopened/);
  await batch([entry("approve_training", 7)], manager);
  assert.equal(
    (
      await db.query(
        "select status from workforce_payout_attendance_facts where workforce_id=$1 and punch_date=$2",
        [worker, date],
      )
    ).rows[0].status,
    "P",
  );
  for (let n = 16; n <= 17; n++) {
    const day = `2026-10-${n}`;
    for (const who of [worker, owner])
      await db.query(
        "insert into attendance_punches(id,company_id,account_id,location_id,punch_date,source) values(gen_random_uuid(),$1,$2,$3,$4,'biometric')",
        [company, who, station, day],
      );
    await db.query(
      "insert into cps_shipment_daily(id,company_id,station_code,client,work_date,provider_employee_id,total_delivery,amazon_delivery) values($1,$2,'TEST','Amazon',$3,'OWNER',10,10)",
      [id(220 + n), company, day],
    );
  }
  await batch([training(0, "2026-10-16", id(236))]);
  await assert.rejects(
    batch([training(0, "2026-10-17", id(237))]),
    /Two training days/,
  );
  await assert.rejects(
    batch([entry("not_worked", 8), entry("not_worked", 0, "2026-10-16")]),
    /Another reviewer/,
  );
  const state = (
    await db.query(
      "select status,review_version from workforce_buddy_training_requests where workforce_id=$1 and work_date=$2",
      [worker, date],
    )
  ).rows[0];
  assert.equal(state.status, "approved");
  assert.equal(
    state.review_version,
    8,
    "Failed second day must roll back the first day",
  );
  await assert.rejects(
    db.query("update workforce set created_at='2026-11-01' where id=$1", [
      worker,
    ]),
    /Registration date/,
  );
  await assert.rejects(
    db.query("update cps_shipment_daily set total_delivery=99 where id=$1", [
      source,
    ]),
    /training request/,
  );
  await assert.rejects(
    db.query(
      "delete from attendance_punches where account_id=$1 and punch_date=$2",
      [owner, date],
    ),
    /training/i,
    "Buddy attendance evidence cannot be removed during active training",
  );
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('authenticated','public.save_workforce_worked_id_batch(uuid,uuid,jsonb)','execute') ok",
      )
    ).rows[0].ok,
    false,
  );
  console.log(
    "Expanded review: owner absence and MG removal/restoration, role/pay exclusions, training registration and two-day guards, CM approval, atomic batch rollback and private access passed.",
  );
}
