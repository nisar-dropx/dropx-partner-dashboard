import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {codStatusExportSheets} from './cod-status-export.ts';
const now=new Date('2026-10-28T12:00:00+05:30');
const at=day=>Date.parse(day+'T10:00:00+05:30');
const location={id:'s1',code:'TIRC',name:'Example',model:'EDSP',region:'AP',manager:'Manager',ageFlagDays:1,reconDueTime:'21:00',maxAgeMinutes:15};
const submitted={id:'r1',code:'AC001',status:'SUBMITTED',expectedAmount:1000,actualAmount:900,variance:0,createdAt:at('2026-10-27'),updatedAt:now.getTime(),submittedAt:now.getTime(),createdBy:'Creator',submittedBy:'Submitter'};
const snapshot={version:1,stationCode:'TIRC',date:'2026-10-28',fetchedAt:now.toISOString(),remittanceWindow:{startTime:at('2026-10-21'),endTime:now.getTime()},reconciliation:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,driverCount:1,pendingCount:1,pendingAmount:650,completedPercent:0,drivers:[{id:'00123',name:'=Literal name',pendingAmount:650,packages:[{trackingId:'001234567890',amount:100,paymentMethod:'CASH',collectedAt:at('2026-10-27'),dateSource:'pending_transaction',transactionAt:at('2026-10-28')},{trackingId:'002234567890',amount:200,paymentMethod:'CASH',collectedAt:at('2026-10-28')},{trackingId:'003234567890',amount:300,paymentMethod:'CASH',collectedAt:null,source:'scc_cash_with_associate',sourceUpdatedAt:now.getTime()}]}]}},prepareDeposit:{state:'ok',checkedAt:now.toISOString(),data:{expectedAmount:700,actualAmount:700,variance:0,digitalAmount:250,sourceScope:'outstanding_history',sourceWindow:{startTime:0,endTime:now.getTime()}}},remittances:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,openCount:0,openAmount:0,submittedToday:true,rows:[],latestSubmitted:submitted}}};
const entry={location,snapshot},get=(s,n)=>s.find(x=>x.name===n).rows;
test('date-filtered export matches displayed cash, retaining text IDs and numeric money',()=>{
 const sheets=codStatusExportSheets([entry],{now,collectionDate:'2026-10-27',part:'reconciliation'});
 assert.deepEqual(sheets.map(s=>s.name),['Associates','Shipments','Report info']);
 assert.equal(get(sheets,'Associates')[1][4],100);
 const rows=get(sheets,'Shipments');assert.equal(rows.length,2);assert.equal(rows[1][3],'001234567890');assert.equal(rows[1][6],'Pending transaction · Amazon date');assert.equal(rows[1][10],100);
 const book=XLSX.utils.book_new();for(const sheet of sheets)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(sheet.rows),sheet.name);
 const read=XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
 assert.equal(read.Sheets.Shipments.D2.t,'s');assert.equal(read.Sheets.Shipments.D2.v,'001234567890');assert.equal(read.Sheets.Shipments.K2.t,'n');assert.equal(read.Sheets.Associates.C2.f,undefined);
});
test('age flag exports overdue cohort, independently of the date dropdown like the screen',()=>{
 const sheets=codStatusExportSheets([entry],{now,collectionDate:'2026-10-28',part:'reconciliation',agedOnly:true});
 assert.equal(get(sheets,'Shipments').length,2);assert.equal(get(sheets,'Shipments')[1][3],'001234567890');assert.equal(get(sheets,'Associates')[1][4],100);
});
test('undated cash keeps missing breakdown and source update separate from collection date',()=>{
 const sheets=codStatusExportSheets([entry],{now,collectionDate:'undated',part:'reconciliation'});
 assert.equal(get(sheets,'Associates')[1][4],350);assert.equal(get(sheets,'Associates')[1][7],50);
 const row=get(sheets,'Shipments')[1];assert.equal(row[5],'Date unverified');assert.equal(row[8],null);assert.equal(row[11],'SCC cash state update');
});
test('filtered overview includes only provided locations and keeps missing amounts unavailable',()=>{
 const sheets=codStatusExportSheets([entry,{location:{...location,id:'s2',code:'NO-DATA'}}],{now,collectionDate:'2026-10-27'});
 const overview=get(sheets,'Station overview');assert.equal(overview.length,3);assert.equal(overview[1][8],100);assert.equal(overview[2][8],'Not available');assert.equal(overview[2][10],'Not available');
 assert.equal(get(sheets,'Prepare deposit')[1][1],700);assert.equal(get(sheets,'Prepare deposit')[1][4],250);
});
test('remittance export includes summary-only latest submission and calculated shortage',()=>{
 const sheets=codStatusExportSheets([entry],{now,collectionDate:'2026-10-27',part:'remittances'});
 assert.deepEqual(sheets.map(s=>s.name),['Remittances','Report info']);const row=get(sheets,'Remittances')[1];assert.equal(row[1],'AC001');assert.equal(row[6],-100);assert.match(row[3],/Short/);
});
test('unavailable sections and failed refresh are labelled rather than inventing clearance',()=>{
 const sheets=codStatusExportSheets([{location,error:'Refresh failed'}],{now,collectionDate:'',part:'prepareDeposit'});
 assert.equal(get(sheets,'Prepare deposit')[1][1],'Not available');assert.match(JSON.stringify(get(sheets,'Report info')),/Refresh failed/);
});
