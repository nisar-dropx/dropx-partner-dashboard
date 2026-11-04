import test from 'node:test';
import assert from 'node:assert/strict';
import { filterBoardStations, boardDeliverySummary, prepareBoardReport } from './compact-board-report.ts';
import { normalizeBoard } from './station-board.ts';

const station = (code, rows) => ({ stationCode: code, board: normalizeBoard({ daDsr: rows }), hasSnapshot: true });
const da = (name, delivered, failed, rejected, oor) => ({ driverId:name, driverName:name, delivered, failed, rejected, oor, total:delivered+failed+rejected+oor });
const stations = [station('KLZA',[da('A',90,5,2,3),da('B',0,2,0,8)]),station('GDRD',[da('C',1,0,0,9)])];
test('station, cluster and region multi-selects intersect and never add records outside the payload',()=>{
 const clusters=[{value:'clm',label:'Manager',stations:['KLZA','GDRD','UNAUTHORISED']}];
 assert.deepEqual(filterBoardStations(stations,{stations:[],clusters:['clm'],regions:['KL']},clusters).map(s=>s.stationCode),['KLZA']);
 assert.equal(filterBoardStations(stations,{stations:['GDRD'],clusters:['clm'],regions:['KL']},clusters).length,0);
 assert.equal(filterBoardStations(stations,{stations:[],clusters:['unknown'],regions:[]},clusters).length,0);
 assert.equal(filterBoardStations(stations,{stations:['KLZA','GDRD'],clusters:[],regions:['KL','AP']},clusters).length,2);
});
test('summary keeps delivery failures and rejections separate without an attempted aggregate',()=>{
 const all=boardDeliverySummary(stations);
 assert.equal(all.total,120);assert.equal(all.dsrPct,91/120*100);assert.equal(all.failed,7);assert.equal(all.rejected,2);assert.equal('attempted' in all,false);assert.equal('attemptPct' in all,false);
 const zero=boardDeliverySummary(stations,true);
 assert.equal(zero.total,10);assert.equal(zero.dsrPct,0);assert.equal(zero.failed,2);assert.equal(zero.rejected,0);assert.equal(zero.oor,8);assert.equal(zero.daCount,1);
 assert.equal(boardDeliverySummary([]).dsrPct,null);
});
const cells=(xs)=>xs.map(v=>({text:String(v)}));
const table={title:'DSR',subtitle:'Today',headers:['Station',"DA's Name",'Delivered','Delivery Failed','Delivery Rejected','Out on Road','Total','DSR%'],rows:[cells(['KLZA','Low',0,0,0,10,10,'0%']),cells(['GDRD','Other',5,0,0,5,10,'50%']),cells(['KLZA','High',9,0,0,1,10,'90%']),cells(['Grand Total','3 DAs',14,0,0,16,30,'47%'])]};
test('DSR columns, group sorting, station-once presentation and totals stay consistent for every export',()=>{
 const r=prepareBoardReport(table,{header:'DSR%',direction:'desc'},{dsr:true,singleStation:false});
 assert.deepEqual(r.headers,['Station',"DA's Name",'Total','Delivered','Out on Road','Delivery Failed','Delivery Rejected','DSR%']);
 assert.deepEqual(r.rows.map(r=>r[1].text),['Other','High','Low','3 DAs']);
 assert.deepEqual(r.rows.map(r=>r[0].text),['GDRD','KLZA','','Grand Total']);
 assert.deepEqual(r.rowStations,['GDRD','KLZA','KLZA','']);
 assert.equal(table.rows[0][0].text,'KLZA');
 const asc=prepareBoardReport(table,{header:'DSR%',direction:'asc'},{dsr:true,singleStation:false});
 assert.deepEqual(asc.rows.slice(1,3).map(r=>r[1].text),['Low','High']);
 const byStation=prepareBoardReport(table,{header:'Station',direction:'desc'},{dsr:true,singleStation:false});
 assert.equal(byStation.rows[0][0].text,'KLZA');
});
test('single station omits the redundant column without losing grand-total alignment',()=>{
 const r=prepareBoardReport({...table,rows:table.rows.filter(r=>r[0].text!=='GDRD')},{header:'DSR%',direction:'desc'},{dsr:true,singleStation:true});
 assert.equal(r.headers[0],"DA's Name");assert.equal(r.rows[0][0].text,'High');assert.equal(r.rows.at(-1)[0].text,'Grand Total');
 assert(r.rows.every(row=>row.length===r.headers.length));
});
test('other board tabs sort numeric values while holding the total at the bottom',()=>{
 const r=prepareBoardReport({title:'Ageing',subtitle:'',headers:['Station','Total ₹'],rows:[cells(['KLZA','1,200']),cells(['GDRD','90']),cells(['Grand Total','1,290'])]},{header:'Total ₹',direction:'asc'},{dsr:false,singleStation:false});
 assert.deepEqual(r.rows.map(r=>r[0].text),['GDRD','KLZA','Grand Total']);
});


test('zero-delivery layout sorts across stations, repeats station codes and retains totals',()=>{
 const options={dsr:true,singleStation:false,groupByStation:false};
 const r=prepareBoardReport(table,{header:'Out on Road',direction:'desc'},options);
 assert.deepEqual(r.rows.map(row=>row[1].text),['Low','Other','High','3 DAs']);
 assert.deepEqual(r.rows.map(row=>row[0].text),['KLZA','GDRD','KLZA','Grand Total']);
 assert(r.groupStarts.every(value=>!value));
 const asc=prepareBoardReport(table,{header:'Out on Road',direction:'asc'},options);
 assert.deepEqual(asc.rows.map(row=>row[1].text),['High','Other','Low','3 DAs']);
 const byStation=prepareBoardReport(table,{header:'Station',direction:'asc'},options);
 assert.deepEqual(byStation.rows.map(row=>row[0].text),['GDRD','KLZA','KLZA','Grand Total']);
});
