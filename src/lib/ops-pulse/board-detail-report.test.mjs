import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCReturnAssociates, cReturnDetailTable, dsrStationTable } from './board-detail-report.ts';
import { prepareBoardReport } from './compact-board-report.ts';
import { normalizeBoard } from './station-board.ts';
const shipment = (stationCode, trackingId, driverId, status, driverName = driverId) => ({ stationCode, trackingId, driverId, status, driverName });
const records = [shipment('KLZA','1','A','ON_ROAD_WITH_DELIVERY_ASSOCIATE'), shipment('KLZA','2','A','DELIVERED'), shipment('KLZA','3','','AT_STATION'), shipment('KLZA','4','B','CANCELLED'), shipment('GDRD','5','A','DELAYED'), shipment('GDRD','6','A','UNPICKUPABLE'), shipment('GDRD','7','A','UNKNOWN')];
const associates = aggregateCReturnAssociates([...records, records[0]]);
const stations = ['KLZA','GDRD'].map(stationCode => ({ stationCode, fetchedAt:'2026-11-03T08:00:00Z', board:normalizeBoard({}) }));
test('C-Return groups by station and driver, retains unassigned, deduplicates shipments and rolls up pickup states',()=>{
 assert.equal(associates.length,4);
 assert.equal(associates.reduce((n,r)=>n+r.total,0),7);
 assert.equal(associates[0].statuses.PICKUP_DONE,1);
 assert.equal(associates[1].driverName,'Unassigned');
 assert.equal(associates[3].stationCode,'GDRD');
});
test('C-Return pending counts exclude terminal statuses; global sorting and exports retain station identity',()=>{
 const table=cReturnDetailTable(stations,associates,'associate',{});
 const report=prepareBoardReport(table,{header:'Pending pickup',direction:'desc'},{dsr:false,singleStation:false,groupByStation:false});
 assert.equal(report.rows[0][0].text,'GDRD');
 assert.equal(report.rows[0][3].text,'2');
 assert.equal(report.rows.at(-1)[2].text,'7');
 assert.equal(report.rows.at(-1)[3].text,'4');
 assert.equal(report.rows.at(-1).at(-1).text,'14.29%');
 assert(report.headers.includes('Other'));
 assert(report.groupStarts.every(v=>!v));
 const grouped=prepareBoardReport(table,{header:'Pending pickup',direction:'desc'},{dsr:false,singleStation:false,groupByStation:true});
 assert.equal(grouped.rows[0][0].text,'GDRD');
 assert(grouped.groupStarts.some(Boolean));
 assert(grouped.rows.every(r=>r.length===grouped.headers.length));
 const single=prepareBoardReport(cReturnDetailTable([stations[0]],associates,'associate',{}),{header:'Pending pickup',direction:'desc'},{dsr:false,singleStation:true,groupByStation:false});
 assert.equal(single.headers[0],"DA's Name");
 assert.equal(single.rows.at(-1)[0].text,'Grand Total');
 assert.equal(single.rows.at(-1)[1].text,'4');
});
test('DSR station summary uses weighted totals, retains station and location, sorts across stations',()=>{
 const dsr=[{...stations[0],board:normalizeBoard({daDsr:[{driverId:'A',delivered:90,oor:10,total:100},{driverId:'B',delivered:0,failed:10,total:10}]})},{...stations[1],board:normalizeBoard({daDsr:[{driverId:'C',delivered:1,oor:9,total:10}]})}];
 const table=dsrStationTable(dsr,{KLZA:'Vadakara',GDRD:'Gudur'},false,{KLZA:{eddPending:7,physicalAtStation:12},GDRD:{eddPending:2,physicalAtStation:3}});
 const report=prepareBoardReport(table,{header:'DSR%',direction:'desc'},{dsr:false,singleStation:false,groupByStation:false});
 assert.deepEqual(report.headers,['Station','Location','EDD pending today','Physical at station','Total','Delivered','Out on Road','Delivery Failed','Delivery Rejected','DSR%']);
 assert.deepEqual(report.rows[0].slice(0,6).map(c=>c.text),['KLZA','Vadakara','7','12','110','90']);
 assert.equal(report.rows[0].at(-1).text,'81.82%');
 assert.equal(report.rows.at(-1).at(-1).text,'75.83%');
 assert.equal(dsrStationTable([dsr[0]],{},true).rows[0][2].text,'10');
 const cr=cReturnDetailTable([stations[0]],[],'station',{KLZA:'Vadakara'});
 assert.deepEqual(cr.headers.slice(0,2),['Station','Location']);
 assert.deepEqual(cr.rows[0].slice(0,2).map(c=>c.text),['KLZA','Vadakara']);
});

test('incomplete inventory remains unknown in totals while loaded empty stock is zero',()=>{
 const table=dsrStationTable(stations,{},false,{KLZA:{eddPending:0,physicalAtStation:0}});
 assert.deepEqual(table.rows.map(row=>row.slice(2,4).map(cell=>cell.text)),[['0','0'],['—','—'],['—','—']]);
});
