import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as live from './lm-live-report.ts';
function fixture(){
 const day=new Date(Date.now()+19800000).toISOString().slice(0,10),queued=[];
 const station=(code,age)=>({stationCode:code,businessDate:day,hasSnapshot:true,fetchedAt:new Date(Date.now()-age*60000).toISOString(),board:{daDsr:[{delivered:4,failed:0,rejected:0,oor:6}],cReturnTotal:0,physicalInventoryCount:0}});
 const rows=[station('FRESH',1),station('STALE',60)];
 const dependencies={
  './lm-live-report':live,
  '@/lib/ops-pulse/edd-worker':{fetchLoadFlashBoard:async()=>({stations:rows}),fetchLoadFlashTracking:async()=>[],queueLoadFlashStations:async codes=>queued.push(codes)},
  '@/lib/ops-pulse/station-board-tids':{BOARD_TID:{EDD:'edd',PHYSICAL:'physical',CRETURN:'creturn'},mapBoardTidExportRows:()=>[]},
  '@/lib/ops-pulse/dot-metrics':{stationDotTotals:()=>({})},'./lm-eod-dot':{eodDotRow:()=>({})},
  './lm-eod-order':{orderEodCReturnRows:r=>r,orderEodDotRows:r=>r,orderEodDsrRows:r=>r}
 };
 const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(new URL('./lm-dispatch-data.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',js)(name=>dependencies[name]||{},module,module.exports);
 return {run:allowPartial=>module.exports.loadEodDigest(['FRESH','STALE'],day,{maxAgeMinutes:5,allowPartial}),rows,queued};
}
test('normal live fetch waits for every fresh station; fallback excludes stale numbers and identifies missing sources',async()=>{
 const f=fixture();await assert.rejects(f.run(false),/STALE/);
 const partial=await f.run(true);assert.deepEqual(partial.missingStations,['STALE']);assert.deepEqual(partial.dsr.map(r=>r.Station),['FRESH']);assert.equal(partial.dsr[0].Delivered,4);assert.deepEqual(Object.keys(partial.stationInventory),['FRESH']);
 f.rows[1].fetchedAt=new Date().toISOString();const complete=await f.run(false);assert.deepEqual(complete.missingStations,[]);assert.equal(complete.dsr.length,2);
});
test('fallback never manufactures a report when every station is stale',async()=>{
 const f=fixture();f.rows[0].fetchedAt=f.rows[1].fetchedAt;await assert.rejects(f.run(true),/snapshots missing/);
});
