import test from 'node:test';
import assert from 'node:assert/strict';
import {adhocDaReport} from './adhoc-da-report.ts';

const payment={id:'p1',request_no:'R1',location_id:'s1',station_code:'ERSE',location_code:'ERSE',work_date:'2026-09-10',created_at:'2026-09-10',status:'processed',amount:100,amount_requested:100,amount_approved:90,processed_at:'2026-09-12',paid_at:null,utr_cin:'UTR1',adhoc_work_date:'2026-09-10',adhoc_da_name:'DA One',adhoc_client:'Amazon',adhoc_provider_employee_id:'A001',adhoc_workforce_id:'w1',adhoc_adjustment_id:'a1'};
const shipment={station_code:'ERSE',client:'Amazon',provider_employee_id:'A001',work_date:'2026-09-10',amazon_delivery:20,total_delivery:25};
test('multiple payments count delivery once and deduct only paid amounts',()=>{
 const result=adhocDaReport([payment,{...payment,id:'p2',request_no:'R2',status:'pending',adhoc_adjustment_id:null}], [shipment,{...shipment,station_code:'OTHER',total_delivery:999}], [{id:'a1',amount:90,effective_date:'2026-09-10',status:'approved',payroll_run_id:null}]);
 assert.equal(result.summary.length,1); assert.equal(result.summary[0]['Total delivered (selected range)'],25);
 assert.equal(result.summary[0]['Paid amount'],90); assert.equal(result.summary[0]['Requested amount'],200);
 assert.equal(result.summary[0]['Recovery awaiting payroll'],90); assert.equal(result.details[1]['Paid amount'],0);
});
test('historical unlinked requests are explicit, never falsely attributed',()=>{
 const result=adhocDaReport([{...payment,adhoc_workforce_id:null,adhoc_client:null,adhoc_provider_employee_id:null,adhoc_da_name:null,adhoc_adjustment_id:null}], [shipment], []);
 assert.equal(result.summary[0]['Total delivered (selected range)'],'');
 assert.equal(result.summary[0]['Recovery awaiting payroll'],0);
 assert.equal(result.summary[0]['Tracking'],'Historical — needs manual reconciliation');
});
test('posted adjustment is distinguished from still awaiting payroll',()=>{
 const result=adhocDaReport([payment],[],[{id:'a1',amount:90,effective_date:'2026-10-01',status:'posted',payroll_run_id:'run1'}]);
 assert.equal(result.summary[0]['Recovery in payroll snapshot'],90);
 assert.equal(result.summary[0]['Recovery awaiting payroll'],0);
 assert.equal(result.details[0]['Payroll run ID'],'run1');
});
