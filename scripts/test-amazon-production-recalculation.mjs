import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const co = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
const batch = "00000000-0000-0000-0000-000000000001";
const sql = fs.readFileSync("scripts/recalculate-amazon-production-from-october.sql", "utf8");
await db.exec(`
create table cps_shipment_daily(id uuid primary key,company_id uuid,client text,work_date date,
 station_code text,provider_employee_id text,source_batch_id uuid,amazon_delivery numeric,
 swa_delivery numeric,c_return numeric,mfn numeric,mfn_return numeric,total_delivery numeric,
 total_activity numeric,raw_row_count int,updated_at timestamptz);
create table report_import_rows(batch_id uuid,company_id uuid,source_type text,row_hash text,
 row_number int,normalized_data jsonb,work_date date,station_code text,external_worker_id text);
insert into cps_shipment_daily values
 ('00000000-0000-0000-0000-000000000011','${co}','Amazon','2026-10-01','GNTF','DA','${batch}',23,1,2,0,0,24,26,2,now()),
 ('00000000-0000-0000-0000-000000000012','${co}','Amazon','2026-09-30','GNTF','DA','${batch}',23,1,2,0,0,24,26,2,now());
`);
for (const [type,base,creturn,swa,hash,n] of [
  ["Delivery",23,1,1,"a",1], ["ReturnPickup",0,1,0,"b",2], ["Delivery",23,1,1,"a",3]
]) {
  await db.query(`insert into report_import_rows values($1,$2,'amazon_shipments',$3,$4,$5,'2026-10-01','GNTF','DA')`,
    [batch,co,hash,n,JSON.stringify({shipment_type:type,base_amazon_delivery:base,amazon_delivery:base,
      smd_delivery:0,smd2_delivery:0,final_creturn_count:creturn,c_return:creturn,swa_delivery:swa,
      total_delivery:base+swa,mfn:0,mfn_return:0})]);
}
const auditBefore=(await db.query("select * from report_import_rows order by row_number")).rows;
await db.exec(sql);
let rows=(await db.query("select * from cps_shipment_daily order by work_date")).rows;
assert.equal(rows[0].total_delivery,"24");
assert.equal(rows[0].c_return,"2");
assert.equal(rows[1].total_delivery,"25");
assert.equal(rows[1].amazon_delivery,"24");
assert.equal(rows[1].c_return,"1");
assert.equal(rows[1].total_activity,"26");
assert.equal(rows[1].total_delivery*15+rows[1].c_return*9,384);
const first=structuredClone(rows);
await db.exec(sql);
rows=(await db.query("select * from cps_shipment_daily order by work_date")).rows;
assert.deepEqual(rows,first,"rerun must not add the Delivery C-return twice or touch timestamps");
assert.deepEqual((await db.query("select * from report_import_rows order by row_number")).rows,auditBefore);
await db.exec("update cps_shipment_daily set raw_row_count=3 where work_date='2026-10-01'");
await assert.rejects(db.exec(sql),/source is missing or has drifted/);
await db.exec("rollback");
assert.equal((await db.query("select total_delivery from cps_shipment_daily where work_date='2026-10-01'")).rows[0].total_delivery,"25");
await db.close();
console.log("Amazon production repair: boundary, classification, duplicate handling, idempotence, audit preservation and drift refusal passed.");
