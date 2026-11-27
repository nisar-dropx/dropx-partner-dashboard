import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(path,mocks){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m);return m.exports;}
let preference='amazon_now';
const ctx=compile('./operating-context.ts',{'next/headers':{cookies:()=>({get:k=>k==='dropx-ops-mode'?{value:preference}:undefined})},'@/lib/ops-pulse/cod':{locationModelName:l=>l.model,providerName:l=>l.provider}});
const nav=compile('./navigation.ts',{'@/lib/app-navigation':{fleetNavItem:{code:'fleet',label:'Fleet'}},'@/lib/authorization':{hasPermission:()=>true,isCompanyOwner:()=>false},'@/lib/ops-pulse/cod-pending-access':{canAccessDailyCodPending:()=>true},'@/lib/ops-pulse/last-mile-report-bot-access':{canAccessLastMileReportBot:()=>false},'@/lib/ops-pulse/ds-live-performance-access':{DS_OPERATIONS_PAGE_CODES:['ds_live_performance','ds_ppi','ds_site_summary','ds_datoms','ds_cold_chain_alerts','ds_workforce_pulse','ds_message_policies'],canViewDsOperations:()=>true,canViewDsLivePerformance:()=>true}});
const lm={id:'l',station_code:'LM',model:'EDSP',provider:'Amazon'},ds={id:'d',station_code:'DS',model:'NOW',provider:'Amazon'};
test('workspace selection cannot use a cookie to grant another business location',()=>{preference='amazon_now';const r=ctx.resolveOperatingContext([lm]);assert.equal(r.mode,'amazon_edsp');assert.deepEqual(r.modeLocations,[lm]);assert.deepEqual(r.availableModes.map(x=>x.code),['amazon_edsp']);});
test('dual access offers both workspaces, excluding HO and hidden locations',()=>{const r=ctx.resolveOperatingContext([lm,ds,{...ds,id:'h',is_ho:true},{...ds,id:'x',hide_from_location_list:true}]);assert.equal(r.mode,'amazon_now');assert.deepEqual(r.modeLocations,[ds]);assert.equal(r.availableModes.length,2);});
test('DS has unit costs, Store Health Review Desk, and no last-mile specialist workflows',()=>{
  const catalog=nav.opsNavCatalogForMode('amazon_now');
  const storeAuditsIndex=catalog.findIndex(x=>x.code==='store_audits');
  const performanceIndex=catalog.findIndex(x=>x.code==='performance');
  assert(storeAuditsIndex>=0);
  assert.equal(performanceIndex,storeAuditsIndex+1,'Performance sits immediately after Store Audits');
  const operations=catalog.find(x=>x.label==='Operations');
  assert(operations);
  assert.equal(operations.children?.[0]?.code,'ops_report_bot');
  assert.equal(operations.children?.[0]?.href,'/report-bot?workspace=dark_store');
  assert(operations.children?.some(c=>c.code==='ds_live_performance'&&c.href==='/operations/live'));
  assert(operations.children?.some(c=>c.code==='ds_ppi'&&c.href==='/operations/ppi'));
  assert(operations.children?.some(c=>c.code==='ds_site_summary'&&c.href==='/operations/site-summary'));
  assert(operations.children?.some(c=>c.code==='ds_workforce_pulse'&&c.href==='/operations/workforce-pulse'));
  assert(operations.children?.some(c=>c.code==='ds_datoms'&&c.href==='/operations/datoms/alerts'));
  assert(!operations.children?.some(c=>c.code==='ds_message_policies'),'Message policies removed from Operations (covered by Report Bot).');
  assert(!catalog.some(x=>x.code==='ops_report_bot'&&!x.children));
  const teamOps=catalog.find(x=>x.label==='Team Ops');
  assert(teamOps);
  assert.equal(teamOps.code,'ops_attendance_reports');
  assert(teamOps.children?.some(c=>c.code==='ops_rostering'&&c.href==='/rostering'));
  assert(teamOps.children?.some(c=>c.code==='ops_my_team'&&c.href==='/attendance/my-team'));
  assert(teamOps.children?.some(c=>c.code==='ops_attendance_reports'&&c.href==='/attendance'));
  assert(teamOps.children?.some(c=>c.code==='ops_unplanned_leaves'&&String(c.href).includes('unplanned-leaves')));
  assert(!catalog.some(x=>x.label==='Rostering'&&!x.children));
  assert(!catalog.some(x=>x.code==='workforce'));
  const menus=nav.opsNavItemsForMode('amazon_now',{roleCode:'FSD'});
  assert(menus.some(x=>x.href==='/cpu'));
  assert(menus.some(x=>x.label==='Operations'));
  const performance=menus.find(x=>x.code==='performance');
  assert(performance);
  assert.equal(performance.label,'Performance');
  assert(performance.children?.some(c=>c.code==='performance_review'&&String(c.href).includes('view=reviews')));
  assert(performance.children?.some(c=>c.code==='performance_review_status'&&String(c.href).includes('review-status')));
  assert(!performance.children?.some(c=>c.code==='ds_live_performance'));
  assert(!menus.some(x=>x.code==='performance_review'));
  assert(!menus.some(x=>x.code==='performance_review_status'));
  const shiftMenu=menus.find(x=>x.code==='si_handover');
  assert(shiftMenu);
  assert.equal(shiftMenu.label,'Activities & Handover');
  assert(shiftMenu.children?.some(c=>c.code==='si_handover'&&c.label==='Shift operations'&&String(c.href).includes('view=start')));
  assert(shiftMenu.children?.some(c=>c.code==='store_ops'&&c.label==='Store operations'&&String(c.href).includes('/store-ops')));
  assert(shiftMenu.children?.some(c=>c.label==='Shift report'&&String(c.href).includes('tab=shift')));
  assert(shiftMenu.children?.some(c=>c.label==='Store report'&&String(c.href).includes('tab=store')));
  assert(!shiftMenu.children?.some(c=>c.label==='Activities report'));
  assert(menus.some(x=>x.code==='si_handover_master'||(x.children||[]).some(c=>c.code==='si_handover_master')));
  assert(menus.some(x=>x.code==='store_ops_master'||(x.children||[]).some(c=>c.code==='store_ops_master')));
  for(const code of ['ops_rostering','ops_my_team','ops_attendance_reports','ops_unplanned_leaves','business_documents','payments','ops_reports','master_data','users'])assert(menus.some(x=>x.code===code||(x.children||[]).some(c=>c.code===code)));
  for(const code of ['cod','fleet','capacity','workforce'])assert(!menus.some(x=>x.code===code));
  assert(!performance.children?.some(c=>['daily','sls'].some(part=>String(c.href).includes(`view=${part}`))));
});
test('both workspaces lead to the same complete approvals queue',()=>{const approvals=mode=>nav.opsNavItemsForMode(mode).find(x=>x.code==='payments').children.find(x=>x.code==='payment_approvals');assert.deepEqual(approvals('amazon_edsp'),approvals('amazon_now'));assert.equal(approvals('amazon_now').href,'/payments/approvals');});


test('every workspace exposes Shift Attendance immediately after Command Center using existing roster access',()=>{
  for(const mode of ['amazon_edsp','flipkart_odh_mdh','amazon_now']){
    const menus=nav.opsNavItemsForMode(mode);
    assert.equal(menus[0].label,'Command Center');
    assert.deepEqual(menus[1],{code:'ops_rostering',label:'Shift Attendance',href:'/ops-pulse?view=manpower',icon:'S'});
    assert.equal(menus.filter(item=>item.label==='Shift Attendance').length,1);
  }
});
