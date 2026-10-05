import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
const exports = {};
new Function('exports', ts.transpileModule(fs.readFileSync('src/lib/fleet/vehicle-rent.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(exports);
const parse = exports.parseVehicleRent;
assert.deepEqual(parse({status:'active'}).values, {}, 'Unrelated changes preserve rent');
for (const period of ['daily','monthly']) {
  assert.deepEqual(parse({rent_amount:'1250.50',rent_period:period}).values,{rent_amount:'1250.50',rent_period:period});
  assert.equal(parse({rent_amount:0,rent_period:period}).values.rent_amount,'0.00');
}
assert.deepEqual(parse({rent_amount:'',rent_period:'monthly'}).values,{rent_amount:null,rent_period:null});
for(const amount of ['-1','NaN','Infinity','1.234','1e5','10000000000',{},true]) assert.ok(parse({rent_amount:amount,rent_period:'daily'}).error);
assert.ok(parse({rent_amount:20,rent_period:'weekly'}).error);
assert.ok(parse({rent_period:'daily'}).error);
const db = new PGlite();
await db.exec('create table fleet_vehicles(id integer primary key, ownership_type text); insert into fleet_vehicles values (1,\'own\'),(2,\'odcd\'),(3,\'rented\');');
await db.exec(fs.readFileSync('supabase/migrations/20261005115010_fleet_vehicle_rent_terms.sql','utf8'));
assert.equal((await db.query('select count(*)::int n from fleet_vehicles where rent_amount is null and rent_period is null')).rows[0].n,3);
for(const period of ['daily','monthly']) {
 await db.query('update fleet_vehicles set rent_amount=2500.50,rent_period=$1',[period]);
 assert.equal((await db.query('select count(*)::int n from fleet_vehicles where rent_amount=2500.50 and rent_period=$1',[period])).rows[0].n,3);
}
await assert.rejects(db.exec("update fleet_vehicles set rent_amount=-1"));
await assert.rejects(db.exec("update fleet_vehicles set rent_period='weekly'"));
await assert.rejects(db.exec("update fleet_vehicles set rent_period=null"));
await db.exec('update fleet_vehicles set rent_amount=null,rent_period=null');
await db.close();
console.log('Vehicle rent: daily/monthly, all sources, optional/zero/clear, partial updates, invalid input and database constraints passed.');
