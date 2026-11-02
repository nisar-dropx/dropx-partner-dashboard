import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript'),XLSX=require('xlsx');
function compile(name,mocks){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(name,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:n=>mocks[n]||require(n),Intl,Date});return exports;}
const values=compile('./report-table-values.ts',{});
test('xlsx round trip retains identifiers, typed amounts, all rows, filters and export scope',async()=>{
 let workbook,filename;
 const {downloadReportExcel}=compile('./download-report-excel.ts',{'./report-table-values':values,xlsx:{...XLSX,writeFile:(w,n)=>{workbook=w;filename=n;}}});
 await downloadReportExcel({title:'Redispute tracking',headers:['Shipment ID','Value','Description'],rows:Array.from({length:30},(_,i)=>[i?'515174733475':'000123','₹30,495.50',i?'Example':'=HYPERLINK("untrusted")']),scope:'All 30 filtered records'});
 const restored=XLSX.read(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),{type:'buffer'}),sheet=restored.Sheets.Report;
 assert.equal(filename,'Redispute-tracking.xlsx');assert.equal(sheet.A2.t,'s');assert.equal(sheet.A2.v,'000123');assert.equal(sheet.B2.t,'n');assert.equal(sheet.B2.v,30495.5);assert.equal(sheet.C2.t,'s');assert.equal(sheet.C2.f,undefined);
 assert.equal(XLSX.utils.sheet_to_json(sheet).length,30);assert.equal(sheet['!autofilter'].ref,'A1:C31');assert.equal(restored.Sheets['Export details'].B2.v,'All 30 filtered records');
});
