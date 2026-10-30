import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL('./model.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(()=>({}),m.exports,m);
const {reconcileBilling,zeroHeads}=m.exports;
const station=(code,base=code,active=true,aliases=[])=>({code,base,active,aliases,region:'TEST',model:'EDSP'});
const invoice=(station,head='Amazon MG Income',paise=10000)=>({key:station,station,reference:station,date:'2026-10-07',taxPaise:1800,totalPaise:11800,issues:[],entries:[{id:station,head,paise,side:'income'}]});
const reference={month:'2026-09',source:'test.xlsx',sha256:'test',stations:[{station:'A',row:2,days:30,total:100,rates:{mg:100,mgVolume:1000,fee:0,variable:20,mfn:5,swaCod:28,swaPrepaid:25,swaReject:10},counts:{delivered:1100,returns:100,eligible:1200,mfn:0,swa:0},heads:{...zeroHeads(),mg:100}}]};
test('raw invoice reconciliation excludes GST and separates deductions; XPT rolls once and inactive children stay outside',()=>{
 const doc=invoice('A');doc.entries.push({id:'loss',head:'Loss chargeback',paise:500,side:'expense'});
 const rows=reconcileBilling({month:'2026-09',reference,invoices:[doc,invoice('XP','Amazon XPT Income',3000),invoice('CLOSED','Amazon XPT Income',700)]},null,[station('A'),station('X','A',true,['XP']),station('CLOSED','A',false)]);
 assert.equal(rows.find(r=>r.code==='A').income,13000);assert.equal(rows.find(r=>r.code==='A').debit,500);assert.equal(rows.find(r=>r.code==='A').workbookDifference,3000);assert.equal(rows.find(r=>r.code==='CLOSED').active,false);
 assert.equal(rows.find(r=>r.code==='A').provisional,null);
});
test('prior-month workbook is only a rate reference; missing invoice and feed never become zero revenue',()=>{
 const rows=reconcileBilling({month:'2026-10',reference,invoices:[]},null,[station('A')]);
 assert.equal(rows[0].benchmark,null);assert.equal(rows[0].income,null);assert.equal(rows[0].provisionalDifference,null);assert.match(rows[0].issues.join(),/reference only/);
});
test('rate and source-count mismatches are actionable; aliases cannot silently overwrite a station',()=>{
 const live={locations:[{station_code:'A'}],revenueCalculations:[{station:'A',provider:'Amazon',model:'mg',base:'100',variable:'500',mfnRevenue:'0',swaRevenue:'0',eligibleDeliveries:'1300',returns:'100',issues:[]}],pricing:[{station:'A',provider:'Amazon',mg:'100',mgVolume:'1000',monthlyFee:'0',variable:'25',mfn:'5'}],coverage:[]};
 const [row]=reconcileBilling({month:'2026-09',reference,invoices:[invoice('A')]},live,[station('A')]);
 assert.equal(row.provisional,60000);assert.equal(row.rateDifferences.length,1);assert.match(row.rateDifferences[0],/Excess rate/);assert.equal(row.countDifferences.length,2);
 assert.throws(()=>reconcileBilling({month:'2026-09',reference:null,invoices:[]},null,[station('A','A',true,['B']),station('B')]),/Ambiguous/);
});

 test('workbook base-station quantities and variable income include XPT while fixed XPT stays separate',()=>{
 const day={provider:'Amazon',base:'100',variable:'20',mfnRevenue:'0',swaRevenue:'0',eligibleDeliveries:'10',returns:'2',issues:[]};
 const live={locations:[{station_code:'A'},{station_code:'X'}],pricing:[],coverage:[],revenueCalculations:[{...day,station:'A',model:'mg'},{...day,station:'X',model:'xpt',base:'30',variable:'50'}]};
 const [row]=reconcileBilling({month:'2026-09',reference,invoices:[]},live,[station('A'),station('X','A')]);
 assert.equal(row.estimate.mg,10000);assert.equal(row.estimate.variable,7000);assert.equal(row.estimate.xpt,3000);assert.equal(row.counts.eligible,20);assert.equal(row.counts.returns,4);assert.equal(row.provisional,20000);
 });

test('I H S MG invoice lines remain IHS rather than creating a false base-MG difference',()=>{
 const doc=invoice('A');doc.entries.push({id:'ihs',head:'Amazon MG Income',description:'I H S MG Payout',paise:650,side:'income'});
 const [row]=reconcileBilling({month:'2026-09',reference:null,invoices:[doc]},null,[station('A')]);
 assert.equal(row.billed.mg,10000);assert.equal(row.billed.ihs,650);assert.equal(row.income,10650);
});
