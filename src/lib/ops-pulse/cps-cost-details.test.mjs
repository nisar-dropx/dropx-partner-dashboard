import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const mod={exports:{}};
new Function('exports','module',ts.transpileModule(readFileSync(new URL('./cps-cost-details.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod.exports,mod);
const {facilityRentDetails,groupVanCosts}=mod.exports;
const line=(sub_head,source,amount,extra={})=>({station_code:'A',work_date:'2026-10-01',head:'Van',sub_head,source,amount,...extra});
test('van grouping preserves every charge and adjustment exactly once across sources',()=>{
 const lines=[line('Vehicle rent · V1','Fleet Vehicle Master',500),line('Vehicle rent · V2','Fleet Vehicle Master',400),line('Vehicle Maintanance Expenses','Cashbook',100),line('Van Adhoc','Cashbook',90),line('Adhoc Van','Approved payment requests',80),line('Adhoc Driver','Approved payment requests',70),line('IOCL','Fuel import',60),line('Per package','Workforce rate card',50),line('Unfamiliar master head','Cost setup',40),line('Unfamiliar master head','Cost setup',-10),line('DA pay','Workforce rate card',999,{head:'DA'})];
 const groups=groupVanCosts(lines);
 assert.equal(groups.length,6);
 assert.equal(groups.find(g=>g.key==='rental').amount,900);
 assert.equal(groups.find(g=>g.key==='adhoc').amount,240);
 assert.equal(groups.find(g=>g.key==='other').amount,30);
 assert.equal(groups.reduce((n,g)=>n+g.amount,0),1380);
 assert.equal(groups.flatMap(g=>g.items.flatMap(i=>i.lines)).length,10);
});
const master=(extra={})=>({id:'r1',site_code:'A',allocation_station_code:'A',monthly_rent:75000,monthly_maintenance:0,effective_from:'2026-09-01',effective_to:null,...extra});
const rentLines=dates=>dates.map(work_date=>line('Facility rent and maintenance','Finance Rent Master',0,{head:'Rent',work_date}));
test('rent details show source monthly values and only charged dates',()=>{
 const result=facilityRentDetails([master(),master({id:'out-of-scope',allocation_station_code:'B'})],rentLines(['2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06']));
 assert.equal(result.length,1);assert.equal(result[0].monthly_rent,75000);assert.equal(result[0].days,6);assert.equal(result[0].calendar_days,31);assert.equal(result[0].amount,14516.13);
});
test('rent revisions, sites, maintenance and calendar months remain separate',()=>{
 const records=[master({monthly_rent:30000,monthly_maintenance:1000,effective_to:'2026-09-30'}),master({id:'r2',monthly_rent:62000,effective_from:'2026-10-01'}),master({id:'annex',site_code:'ANNEX',monthly_rent:3100,effective_from:'2026-10-01'})];
 const result=facilityRentDetails(records,rentLines(['2026-09-30','2026-10-01','2026-10-02']));
 assert.equal(result.length,3);
 assert.deepEqual(result.map(r=>r.amount),[1033.33,4000,200]);
 assert.deepEqual(result.map(r=>r.calendar_days),[30,31,31]);
});
test('missing rent evidence does not invent a monthly rate',()=>{
 assert.deepEqual(facilityRentDetails([],rentLines(['2026-10-01'])),[]);
 assert.deepEqual(facilityRentDetails([master()],[]),[]);
});
