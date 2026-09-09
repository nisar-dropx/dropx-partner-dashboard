import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const output=ts.transpileModule(read('src/lib/ops-pulse/unplanned-leaves.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {unplannedFilters,unplannedQuery,leaveReport,leaveExportRows,leaveOutcome}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
const clock=new Date('2026-09-10T05:00:00Z');
const filters=unplannedFilters(new URLSearchParams(),clock);
assert.equal(filters.from,'2026-09-10');assert.equal(filters.to,'2026-09-10');assert.equal(filters.backlog,true);
assert.equal(unplannedFilters(new URLSearchParams('date=2026-09-07'),clock).from,'2026-09-07');
for(const query of ['from=2026-02-30','to=2099-01-01','from=2026-08-01&to=2026-09-09','from=2026-09-10&to=2026-09-09','location=a&location=b']) assert.throws(()=>unplannedFilters(new URLSearchParams(query),clock));
assert.equal(unplannedFilters(new URLSearchParams('backlog=0&backlog=1'),clock).backlog,true);
assert.equal(unplannedFilters(new URLSearchParams('backlog=0'),clock).backlog,false);
const base={worker_name:'Person',worker_code:'P1',worker_type:'employee',employment_status:'active',employment_active:true,attendance_date:'2026-09-10',location_id:'a',location_code:'A',cluster:'South',region:'KL',status:{id:'contact',label:'To contact',tone:'amber',is_terminal:false,display_order:10},recorded_punch_count:0};
const data={today:'2026-09-10',rows:[
 {...base,id:'today'}, {...base,id:'earlier',attendance_date:'2026-09-09'},
 {...base,id:'punch',recorded_punch_count:1,first_punch_at:'2026-09-10T02:00:00Z'},
 {...base,id:'pending',pending_punches:true,check_out_at:'2026-09-10T11:00:00Z'},
 {...base,id:'leave',excluded_at:'2026-09-10T02:00:00Z',exclusion_reason:'Approved leave'},
 {...base,id:'closed',status:{...base.status,is_terminal:true}},
 {...base,id:'old-punch',attendance_date:'2026-09-09',recorded_punch_count:1},
 {...base,id:'other-location',location_id:'b',worker_name:'Other'},
 {...base,id:'inactive',employment_active:false}
]};
const open=leaveReport(data,filters);
assert.deepEqual(open.summary,{today:3,earlier:1,open:4,updated:4,punched:2});
assert(!open.rows.some(r=>r.id==='old-punch'));
assert.equal(leaveReport(data,{...filters,backlog:false}).rows.length,3);
assert.equal(leaveReport(data,{...filters,location:'outside'}).rows.length,0);
assert.equal(leaveReport(data,{...filters,location:'a',employment:'active'}).rows.length,2);
assert.equal(leaveReport(data,{...filters,search:'OTHER'}).rows[0].id,'other-location');
assert.equal(leaveReport(data,{...filters,view:'updated',status:'punch_pending'}).rows[0].id,'pending');
assert.equal(leaveOutcome(data.rows[4]).label,'Approved leave');
const updated=leaveReport(data,{...filters,view:'updated'});
assert.equal(leaveExportRows(updated.rows).length,updated.rows.length);
assert.equal(leaveExportRows(updated.rows).find(r=>r['Attendance status']==='Punch pending approval')['Check-out (IST)'],'4:30 pm');
const many={...data,rows:Array.from({length:101},(_,i)=>({...base,id:String(i)}))};
assert.equal(leaveReport(many,{...filters,page:8}).page,3);assert.equal(leaveReport(many,{...filters,page:8}).pageRows.length,1);
assert.equal(leaveExportRows(leaveReport(many,{...filters,page:2}).rows).length,101);
const query=unplannedQuery({...filters,location:'a',view:'updated',page:2});
assert.deepEqual(unplannedFilters(new URLSearchParams(query),clock),{...filters,location:'a',view:'updated',page:2});
const server=read('src/lib/ops-pulse/unplanned-leaves-data.ts');
assert(server.includes('p_user_id: auth.userId'));assert(server.includes('p_location_ids: auth.locationScopeIds'));assert(server.includes('auth.hasAllLocationAccess'));
assert(!server.includes('hr_refresh_unplanned_leave_punches'));assert(!server.includes('hr_sync_unplanned_leave_cases'));
const api=read('src/app/api/ops-pulse/unplanned-leaves/route.ts');assert(api.includes('private, no-store'));assert(api.includes('status: 403'));assert(!/export async function (POST|PUT|PATCH|DELETE)/.test(api));
const sql=read('supabase/migrations/20260909193341_ops_people_leave_view.sql');
assert(sql.includes('stable security invoker'));assert(sql.includes('from public,anon,authenticated'));assert(!/\b(update|insert|delete)\s+public\./i.test(sql));
assert(!sql.includes('hr_note'));assert(!read('src/components/ops-unplanned-leaves.tsx').includes('textarea'));
console.log('PASS: People open/updated outcomes, backlog, date ranges, location filters, pagination, Excel parity and read-only boundaries');
