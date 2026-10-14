import test from 'node:test';
import assert from 'node:assert/strict';
import {mappingScheduleError,nextMappingPeriodStart} from './provider-mapping-schedule.ts';
import {providerMappingStationFamily,providerFirstWorkerIsSelectable} from './provider-first-mapping-view.ts';
import {filterProviderMappingLookup} from './provider-mapping-lookup.ts';
import {mappingAuditForRow,mappingAuditDateTime} from './provider-mapping-audit.ts';
const period=(from,to='')=>({effectiveFrom:from,effectiveTo:to,paymentMethodId:'method',paymentValues:{DELIVERY:'10'},productionThresholdMinimumUnits:''});
test('inclusive payment dates permit cross-month plans and only the final open end',()=>{
 assert.equal(nextMappingPeriodStart('2026-10-31'),'2026-11-01');
 assert.equal(nextMappingPeriodStart('2028-02-28'),'2028-02-29');
 assert.equal(nextMappingPeriodStart('2026-02-30'),'');
 assert.equal(mappingScheduleError([period('2026-10-01','2026-10-31'),period('2026-11-01')]),null);
 assert.match(mappingScheduleError([period('2026-10-01'),period('2026-11-01')]),/end date/);
 for(const start of ['2026-10-31','2026-11-02'])assert.match(mappingScheduleError([period('2026-10-01','2026-10-31'),period(start)]),/overlap or leave a gap/);
 assert.match(mappingScheduleError([period('2026-10-01','2026-10-31'),{...period('2026-11-01'),paymentValues:{DELIVERY:'-1'}}]),/non-negative/);
});
const row={stationId:'a',relatedStationIds:['a','x'],providerId:'amz',providerMemberId:'111',workforceId:'',effectiveFrom:'2026-10-01',effectiveTo:''};
const worker={id:'w',profileStationId:'a',stationId:'a',providerId:'amz',dateOfJoin:'2026-10-01',mappingId:'',mappedProviderMemberId:'',currentMappings:[]};
test('dropdown includes other permitted stations, excludes assigned IDs and unsaved reservations, and preserves current selection',()=>{
 assert.equal(providerFirstWorkerIsSelectable(row,worker),true);
 assert.equal(providerFirstWorkerIsSelectable(row,{...worker,profileStationId:'b'}),true);
 assert.equal(providerFirstWorkerIsSelectable(row,{...worker,hasRestrictedMapping:true}),false);
 assert.equal(providerFirstWorkerIsSelectable(row,{...worker,mappingHistory:[{mappingId:'bounded',providerId:'amz',mappedProviderMemberId:'222',status:'closed',effectiveTo:'2999-12-31'}]}),false);
 assert.equal(providerFirstWorkerIsSelectable(row,{...worker,currentMappings:[{mappingId:'m',stationId:'a',providerId:'amz',mappedProviderMemberId:'222',effectiveTo:'',status:'active'}]}),false);
 assert.equal(providerFirstWorkerIsSelectable(row,worker,[{...row,providerMemberId:'222',workforceId:'w'}]),false);
 assert.equal(providerFirstWorkerIsSelectable({...row,workforceId:'w'},{...worker,profileStationId:'b'}),true);
});
test('station family comes from provider and XPT parent relationship',()=>{
 const stations=[{id:'a',provider_id:'amz',modelCode:'EDSP'},{id:'x',parent_station_id:'a',provider_id:'amz',modelCode:'XPT'},{id:'b',parent_station_id:'a',provider_id:'amz',modelCode:'AMXL'},{id:'other',parent_station_id:'a',provider_id:'flip',modelCode:'XPT'}];
 assert.deepEqual(providerMappingStationFamily('a',stations),['a','x']);assert.deepEqual(providerMappingStationFamily('x',stations),['a','x']);
 const anchor={mappingId:'m',stationId:'a',providerId:'amz',mappedProviderMemberId:'111',effectiveFrom:'2026-10-01',effectiveTo:'',status:'active'};
 assert.equal(providerFirstWorkerIsSelectable({...row,stationId:'x'},{...worker,mappingId:'m',mappedProviderMemberId:'111',currentMappings:[anchor],registeredLocationMappings:[anchor]}),true);
});
test('lookup matches employee or provider identity across months and optionally ended records',()=>{
 const base={stationId:'a',dropxId:'DF1199',fullName:'Asha Devi',providerMemberId:'2001',providerMemberName:'Asha',stationLabel:'GDRD',profileLocationLabel:'GDRD',history:[{storedStatus:'active',effectiveTo:''}]};
 assert.equal(filterProviderMappingLookup([base],'df1199','',false).length,1);
 assert.equal(filterProviderMappingLookup([base],'asha 2001','a',false).length,1);
 assert.equal(filterProviderMappingLookup([base],'asha','b',false).length,0);
 assert.equal(filterProviderMappingLookup([{...base,history:[{storedStatus:'closed',effectiveTo:'2999-12-31'}]}],'asha','',false).length,1);
 const ended={...base,history:[{storedStatus:'closed',effectiveTo:'2026-09-30'}]};
 assert.equal(filterProviderMappingLookup([ended],'asha','',false).length,0);
 assert.equal(filterProviderMappingLookup([ended],'asha','',true).length,1);
});
test('history resolves real reviewer and IST time without attributing an unknown update to creator',()=>{
 const m={id:'m',workforce_id:'w',provider_id:'p',provider_member_id:'111',station_id:'a',effective_from:'2026-10-01',created_by:'creator',created_at:'2026-10-01T02:00:00Z',updated_at:'2026-10-13T14:00:00Z'};
 const event={id:'e',workforce_id:'w',event_code:'provider_mapping_saved',actor_id:'editor',actor_name:'Dashboard mapping reviewer',created_at:m.updated_at,details:{provider_id:'p',provider_member_id:'111',station_id:'a',effective_from:m.effective_from}};
 const names=new Map([['creator','Creator'],['editor','Actual Reviewer']]);
 assert.equal(mappingAuditForRow(m,[event],names)[0].actor,'Actual Reviewer');
 assert.equal(mappingAuditForRow(m,[{...event,details:{...event.details,effective_from:'2026-09-01'}}],names)[0].actor,'User not recorded');
 assert.match(mappingAuditDateTime(event.created_at),/Tue.*13.*Oct.*2026.*07:30 pm IST/);
});
