import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>id in mocks?mocks[id]:require(id),m.exports,m);return m.exports;}
const pricing=compile('./pricing.ts'),details=compile('../ops-pulse/cps-details.ts');
const {buildPnlEvidence,evidenceStations,calendarAccrual}=compile('./pnl-evidence.ts',{'./pricing':pricing,'../ops-pulse/cps-details':details});
test('Finance detail scope rejects any unauthorized or empty station',()=>{
 assert.deepEqual(evidenceStations('A,A,B',['A','B']),['A','B']);
 for(const query of ['A,X','',undefined,[],','])assert.throws(()=>evidenceStations(query,['A']));
});
test('calendar accrual reconciles February, leap month, 30 and 31 days',()=>{
 for(const month of ['2025-02','2024-02','2026-09','2026-10']){
  const count=Number(pricing.monthEnd(month).slice(8));let actual=0;
  for(let day=1;day<=count;day++)actual+=calendarAccrual('1000.01',`${month}-${String(day).padStart(2,'0')}`);
  assert.ok(Math.abs(actual-1000.01)<1e-7);
 }
});
const staff={person_id:'one',name:'Finance staff',code:'S1',role:'SSA',station_code:'A',head:'UTR',group:'Station team',monthly_ctc:31000,amount:1000};
const da={worker_id:'da',name:'Associate',dropx_id:'D1',station_code:'A',cohort:'variable',provider_ids:['P1'],worked:true,work_basis:'shipment activity',deliveries:10,customer_returns:1,seller_pickups:0,seller_returns:0,salary:0,variable:100,fuel:0,van:0,card_from:'2026-10-01',rates:[],source:'Workforce rate card'};
const snap={daily:[{station_code:'A',work_date:'2026-10-01',shipment_present:true},{station_code:'A',work_date:'2026-10-02',shipment_present:true},{station_code:'B',work_date:'2026-10-05',shipment_present:true}],breakup:[{station_code:'A',work_date:'2026-10-02',amount:1000},{station_code:'A',work_date:'2026-10-03',amount:1000},{station_code:'B',work_date:'2026-10-01',amount:1000}],expense_periods:[{station_code:'A',source:'cashbook',source_id:'b',amount:3100,period_from:'2026-10-01',period_to:'2026-10-31',reference:'bill'}],vehicles:[{vehicle_id:'v',station_code:'A',from_date:'2026-10-01',through_date:'2026-10-05',days:5,monthly_rent:3100,amount:500}]};
const evidence={staff:[{...staff,date:'2026-10-01'},{...staff,date:'2026-10-02'},{...staff,date:'2026-10-03'},{...staff,date:'2026-10-01',station_code:'B',name:'Outside'}],associates:[{...da,date:'2026-10-01'},{...da,date:'2026-10-03'}]};
const rents=[{id:'r',site_code:'SITE',allocation_station_code:'A',payee_name:'Landlord',monthly_rent:'3100',monthly_maintenance:'310',effective_from:'2026-09-01'}];
test('salaries, associates, rents, bills and vehicles stop at the same delivered-data cutoff',()=>{
 const out=buildPnlEvidence(snap,evidence,rents,'2026-10-01','2026-10-05',['A']);
 assert.equal(out.staff[0].amount,2000);assert.equal(out.staff[0].days.length,2);
 assert.equal(out.associates[0].variable,100);assert.equal(out.associates[0].deliveries,10);
 assert.equal(out.rents[0].amount,220);assert.equal(out.rents[0].days,2);
 assert.equal(out.bills[0].considered_amount,200);assert.equal(out.vehicles[0].considered_amount,200);
 assert.equal(out.ledger.length,1);assert.ok(!JSON.stringify(out).includes('Outside'));
});
test('custom day detail preserves monthly denominator and returns only that day',()=>{
 const out=buildPnlEvidence(snap,evidence,rents,'2026-10-02','2026-10-02',['A']);
 assert.equal(out.staff[0].amount,1000);assert.equal(out.rents[0].amount,110);assert.equal(out.rents[0].calendar_days,31);assert.equal(out.bills[0].considered_amount,100);
});
test('no delivery data never discloses unrelated People or invents accrued expenses',()=>{
 const out=buildPnlEvidence({...snap,daily:[]},evidence,rents,'2026-10-01','2026-10-05',['A']);
 for(const key of ['staff','associates','rents','bills','vehicles','ledger'])assert.deepEqual(out[key],[]);
});
test('details API authorizes Finance before salary access and fails closed for forged station filters',async()=>{
 let calls=0,permitted=true;
 const {GET}=compile('../../app/finance/business/details/route.ts',{
  '@/lib/supabase-pagination':{readAllRows:async()=>({data:[],error:null})},
  'next/server':{NextResponse:{json:(body,init)=>({body,...init})}},
  '@/lib/finance/data':{financeContext:async code=>{assert.equal(code,'finance_pnl');if(!permitted)throw Error('denied');return {db:{from:()=>{const q=new Proxy({}, {get:()=>()=>q});return q;}},companyId:'tenant',locations:[{station_code:'A'}]};},loadRent:async()=>rents},
  '@/lib/finance/pnl':{pnlFilters:()=>({from:'2026-10-01',to:'2026-10-05'})},
  '@/lib/finance/pnl-evidence':{evidenceStations,buildPnlEvidence},
  '@/lib/ops-pulse/cps-data':{loadFinanceCpsEvidence:async(company,from,to,codes)=>{calls++;assert.equal(company,'tenant');assert.deepEqual(codes,['A']);return {report:snap,evidence};}},
 });
 const invalid=await GET(new Request('https://fin.dropxlogistics.com/finance/business/details?stations=A,B'));
 assert.equal(invalid.status,400);assert.equal(calls,0);
 const good=await GET(new Request('https://fin.dropxlogistics.com/finance/business/details?stations=A'));
 assert.equal(calls,1);assert.equal(good.headers['Cache-Control'],'private, no-store');assert.equal(good.body.staff[0].name,'Finance staff');
 permitted=false;await assert.rejects(GET(new Request('https://fin.dropxlogistics.com/finance/business/details?stations=A')),/denied/);assert.equal(calls,1);
});

test('revenue disclosure shows MG denominator, separate SWA and per-day excess with scoped quantities',()=>{
 const {RevenueCalculation}=compile('../../app/finance/business/pnl-calculations.tsx',{'@/lib/finance/pricing':pricing});
 const day={station:'A',provider:'Amazon',model:'mg',date:'2026-10-01',base:'100.00',eligibleDeliveries:'50',returns:'2',mgVolume:'10',excessVolume:'40',variable:'800',swa:'3',swaRevenue:'60',mfn:'1',mfnRevenue:'5',shipmentReported:true};
 const report={revenueCalculations:[day,{...day,station:'B',base:'99999'}],pricing:[{station:'A',provider:'Amazon',month:'2026-10',mg:'3100',monthlyFee:null,mgVolume:'310',variable:'20',swaRate:'20',effective:'2026-08-01',revision:1}]};
 const render=kind=>renderToStaticMarkup(RevenueCalculation({kind,report,rows:[{station:'A',date:'2026-10-01'}]}));
 assert.match(render('base'),/Monthly minimum guarantee/);assert.match(render('base'),/31/);assert.ok(!render('base').includes('99999'));
 assert.match(render('variable'),/Within MG/);assert.match(render('variable'),/SWA is excluded/);assert.match(render('swa'),/SWA delivered/);
});

test('daily Fleet rent evidence uses the canonical ledger including rent-blocked days and delivery cutoff',()=>{
 const snapshot={...snap,vehicles:[{...snap.vehicles[0],vehicle_no:'V1',monthly_rent:null,daily_rent:800,amount:3200}],breakup:[
 {station_code:'A',work_date:'2026-10-01',source:'Fleet Vehicle Master',sub_head:'Vehicle rent · V1',amount:800},
 {station_code:'A',work_date:'2026-10-02',source:'Fleet Vehicle Master',sub_head:'Vehicle rent · V1',amount:0},
 {station_code:'A',work_date:'2026-10-03',source:'Fleet Vehicle Master',sub_head:'Vehicle rent · V1',amount:800}]};
 const v=buildPnlEvidence(snapshot,evidence,[],'2026-10-01','2026-10-05',['A']).vehicles[0];
 assert.equal(v.daily_rent,800);assert.equal(v.considered_days,2);assert.equal(v.rent_blocked_days,1);assert.equal(v.considered_amount,800);
});
