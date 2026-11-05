import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/fleet/vehicle-type.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
const {vehicleTypeLabel:label, vehicleTypeKey:key, matchesVehicleType:matches, vehicleTypeOptions:options}=exports;
const vendor={sourceId:'vendor',sourceCode:'VNV',sourceName:'Van Vendor',ownershipType:'rented'};
const rental={sourceId:'rental',sourceCode:'VAN',sourceName:'Van Renter',ownershipType:'rented'};
test('vendor and rented vans remain independently selectable despite shared ownership policy',()=>{
 assert.equal(label(vendor),'Van Vendor');assert.equal(label(rental),'Van Rented');
 assert.equal(matches(vendor,[key(rental)]),false);assert.equal(matches(rental,[key(rental)]),true);
 assert.equal(matches(vendor,[key(vendor),key(rental)]),true);
 assert.equal(options([vendor,rental,vendor]).length,2);
});
test('master-defined new types are included without code changes',()=>{
 const custom={sourceId:'custom',sourceCode:'LEASED_EV',sourceName:'Leased EV',ownershipType:'rented'};
 assert.equal(label(custom),'Leased EV');assert.equal(options([custom])[0].value,'source:custom');
});
test('legacy and missing metadata is explicit and cannot falsely match a vendor',()=>{
 assert.equal(label({ownershipType:'own'}),'DropX owned');
 assert.equal(label({sourceCode:'ODCD'}),'ODCD');
 assert.match(label({ownershipType:'rented'}),/not mapped/);
 assert.equal(label(null),'Type not recorded');assert.equal(matches(null,[key(vendor)]),false);
 assert.equal(matches(null,[]),true);
});
