import type { CpsSnapshot, CpsLine, CpsHead, CpsCostInput } from './cps';

// Cost accrual is separate from payroll settlement. Source records are never rewritten.
type RecordRow = Record<string, any>;
export type CpsFacts = {
  shipments: RecordRow[]; volumes: RecordRow[]; mappings: RecordRow[];
  workforce: RecordRow[]; components: RecordRow[]; providers: RecordRow[];
  stations: RecordRow[]; employees: RecordRow[]; salaries: RecordRow[];
  people_rules: CpsCostInput[];
  rent_coverage?: RecordRow[];
  manual_inputs?: CpsCostInput[];
};
export type CpsGap = {
  key: string; kind: string; station_code: string; provider_id: string;
  dropx_id: string; name: string; first_date: string; last_date: string;
  days: number; deliveries: number; known_cost: number; owner: string; href: string;
};
export type CpsPersonCost = {
  id: string; dropx_id: string; name: string; station_code: string;
  salary: number; variable: number; fuel: number; van: number;
  deliveries: number; paid_days: number; zero_delivery_days: number;
};
export type LiveAssociate = RecordRow & {
  id: string; work_date: string; station_code: string; provider_employee_id: string;
  provider_employee_name: string | null; dropx_name: string | null; dropx_emp_code: string | null;
  pay_type: string | null; total_delivery: number; c_return: number; mfn: number; mfn_return: number;
  variable_pay: number; mg_pay: number; fuel_pay: number; van_pay: number;
  da_total_pay: number; mapping_status: string;
};
const key = (s: unknown) => String(s ?? '').trim().toUpperCase();
const compact = (s: unknown) => key(s).replace(/[^A-Z0-9]/g, '');
const num = (n: unknown) => Number.isFinite(Number(n)) ? Number(n) : 0;
const activeOn = (r: RecordRow, date: string) => r.effective_from <= date && (!r.effective_to || r.effective_to >= date);
const employedOn = (r: RecordRow, date: string) => (!r.date_of_join || r.date_of_join <= date) &&
  (!r.last_working_date || r.last_working_date >= date) && (!r.deleted_at || String(r.deleted_at).slice(0,10) > date) &&
  (r.is_active !== false || Boolean(r.last_working_date && r.last_working_date >= date));
export function monthlyAccrual(amount: number, date: string) {
  const [y,m,d] = date.split('-').map(Number);
  const days = new Date(Date.UTC(y,m,0)).getUTCDate();
  return (Math.round(amount * 100 * d / days) - Math.round(amount * 100 * (d-1) / days)) / 100;
}
export function allocateCost(amount: number, codes: string[], volumes: Map<string, number>, allocation='delivery_share') {
  const unique = [...new Set(codes)].sort();
  if (!unique.length) return new Map<string,number>();
  const total = unique.reduce((n,c) => n + Math.max(0,volumes.get(c) ?? 0),0);
  // Cumulative rounding conserves every paise, including equal fallback on zero-volume days.
  let cumulative=0, previous=0;
  return new Map(unique.map(c => {
    cumulative += allocation==='delivery_share' && total>0 ? Math.max(0,volumes.get(c) ?? 0)/total : 1/unique.length;
    const end = Math.round(amount*100*cumulative);
    const value=(end-previous)/100; previous=end;
    return [c,value];
  }));
}
const production = (r: RecordRow, source: unknown): number | null => {
  switch(compact(source)) {
    case 'DELIVERY': case 'TOTALDELIVERY': return num(r.total_delivery);
    case 'AMAZONDELIVERY': return num(r.amazon_delivery);
    case 'SWADELIVERY': return num(r.swa_delivery);
    case 'CRETURN': case 'CUSTOMERRETURN': return num(r.c_return);
    case 'MFN': case 'SELLERPICKUP': return num(r.mfn);
    case 'MFNRETURN': case 'SELLERRETURN': case 'SLLLERRETURN': return num(r.mfn_return);
    default: return null;
  }
};
function configured(r: RecordRow) {
  return Boolean(r.payment_method_id || ['delivery_rate','pickup_rate','mfn_rate','mfn_return_rate','guarantee_amount','fuel_rate'].some(k=>num(r[k])>0));
}
function rateSignature(r: RecordRow) {
  return JSON.stringify([r.payment_method_id, Object.entries(r.payment_values ?? {}).sort(([a],[b])=>a.localeCompare(b)),
    ...['delivery_rate','pickup_rate','mfn_rate','mfn_return_rate','guarantee_amount','guarantee_schedule','fuel_rate'].map(k=>r[k] ?? null)]);
}
export function calculateRateCard(r: RecordRow, components: RecordRow[], shipment: RecordRow, date: string, includeFixed: boolean) {
  const cost={salary:0,variable:0,fuel:0,van:0,missing:false};
  if (r.payment_method_id && !components.length) cost.missing=true;
  const values = Object.fromEntries(Object.entries(r.payment_values ?? {}).map(([k,v])=>[key(k),v]));
  for(const c of components) {
    const code=key(c.component_code), label=key(`${code} ${c.label}`);
    const raw=values[code];
    if(raw==null || String(raw).trim()==='' || !Number.isFinite(Number(raw)) || Number(raw)<0) { cost.missing=true; continue; }
    const rate=Number(raw), isProduction=c.component_type==='production' || c.calculation_type==='count_x_rate';
    const source=c.provider_calculation_sources?.[String(shipment.client ?? 'Amazon').toLowerCase()] || c.calculation_source || code;
    const count=production(shipment,source);
    if(isProduction && count==null) {cost.missing=true;continue;}
    if(!isProduction && !includeFixed) continue;
    const monthly= /month/i.test(String(c.pay_schedule)) || c.calculation_type==='fixed_monthly';
    const amount=isProduction ? rate*count! : monthly ? monthlyAccrual(rate,date) : rate;
    const bucket=/VAN|VEHICLE|DOCK/.test(label) ? 'van' : /FUEL|KILOMET|\bKM\b/.test(label) ? 'fuel' : !isProduction ? 'salary' : 'variable';
    cost[bucket]+=amount;
  }
  if(!components.length && !r.payment_method_id) {
    cost.variable=num(shipment.total_delivery)*num(r.delivery_rate)+num(shipment.c_return)*num(r.pickup_rate)+num(shipment.mfn)*num(r.mfn_rate)+num(shipment.mfn_return)*num(r.mfn_return_rate);
    cost.fuel=num(shipment.total_delivery)*num(r.fuel_rate);
    if(includeFixed) cost.salary=Math.max(0,(/month/i.test(r.guarantee_schedule ?? '') ? monthlyAccrual(num(r.guarantee_amount),date) : num(r.guarantee_amount))-cost.variable);
    if(!configured(r)) cost.missing=true;
  }
  return cost;
}
export function rebuildCps(base: CpsSnapshot, facts: CpsFacts): CpsSnapshot & { associates: LiveAssociate[]; gaps: CpsGap[]; people: CpsPersonCost[] } {
  const stationById=new Map(facts.stations.map(s=>[s.id,s]));
  const selected=new Set(base.daily.map(d=>d.station_code));
  const dates=[...new Set(base.daily.map(d=>d.work_date))].sort();
  const workforce=new Map(facts.workforce.map(w=>[w.id,w]));
  const canonical = (m:RecordRow): RecordRow | undefined => workforce.get(m.workforce_id) ?? facts.workforce.find(w =>
    (w.source_profile_type==='employee' && w.source_profile_id===m.employee_id && m.employee_id) ||
    (w.source_profile_type==='contractor' && w.source_profile_id===m.contractor_id && m.contractor_id) ||
    (w.source_profile_type==='field_executive' && w.source_profile_id===m.field_executive_id && m.field_executive_id));
  const mappings=facts.mappings.map(m=>({...m,worker:canonical(m)})).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
  const components=new Map<string,RecordRow[]>();
  facts.components.forEach(c=>components.set(c.payment_method_id,[...(components.get(c.payment_method_id)??[]),c]));
  const providers=new Map(facts.providers.map(p=>[p.id,compact(`${p.code} ${p.name}`)]));
  const dailyVolumes=new Map<string,Map<string,number>>();
  facts.volumes.forEach(v=>{const map=dailyVolumes.get(v.work_date)??new Map();map.set(v.station_code,num(v.deliveries));dailyVolumes.set(v.work_date,map);});
  const lines:CpsLine[]=base.breakup.filter(l=>l.source!=='Shipment payment mapping').map(l=>({...l,head:l.source==='Finance Rent Master'||(l.head==='Other'&&/^(station|office|premise|facility) rent$/i.test(l.sub_head))?'Rent':l.head}));
  const gaps=new Map<string,CpsGap>();
  const gapDates=new Map<string,Set<string>>();
  function gap(kind:string, station:string,date:string, id='',name='',dropx='',deliveries=0,cost=0, owner='Workforce team') {
    if(!selected.has(station)) return;
    const k=`${kind}|${station}|${id}|${dropx}`;
    const existing=gaps.get(k);
    const seen=gapDates.get(k)??new Set<string>();seen.add(date);gapDates.set(k,seen);
    if(existing) {existing.days=seen.size;existing.first_date=existing.first_date<date?existing.first_date:date;existing.last_date=existing.last_date>date?existing.last_date:date;existing.deliveries+=deliveries;existing.known_cost+=cost;return;}
    gaps.set(k,{key:k,kind,station_code:station,provider_id:id,dropx_id:dropx,name,first_date:date,last_date:date,days:1,deliveries,known_cost:cost,owner,
      href:owner==='People / Finance' ? '/cps?view=inputs' : owner==='Operations uploads' ? 'https://dashboard.dropxlogistics.com/imports' : `https://dashboard.dropxlogistics.com/provider-mapping/${dropx?'':'provider-first'}?q=${encodeURIComponent(dropx || id)}&station=${encodeURIComponent(station)}`});
  }
  const add=(station:string,date:string,head:CpsHead,sub:string,amount:number,source:string) => {
    if(selected.has(station) && amount!==0) lines.push({station_code:station,work_date:date,head,sub_head:sub,amount,source});
  };
  const associates:LiveAssociate[]=facts.shipments.map(s=>({...s,dropx_name:null,dropx_emp_code:null,pay_type:null,variable_pay:0,mg_pay:0,fuel_pay:0,van_pay:0,da_total_pay:0,mapping_status:'Unmapped'} as LiveAssociate));
  const groups=new Map<string,{worker:RecordRow; date:string; rows:LiveAssociate[]; maps:RecordRow[]}>();
  for(const row of associates) {
    const matches=mappings.filter(m=>key(m.provider_member_id)===key(row.provider_employee_id) && activeOn(m,row.work_date) &&
      (!m.station_id || stationById.get(m.station_id)?.station_code===row.station_code) &&
      (providers.get(m.provider_id)??'').includes(compact(row.client)));
    const identities=new Set(matches.map(m=>m.worker?.id).filter(Boolean));
    if(identities.size!==1 || matches.some(m=>!m.worker)) {
      row.mapping_status=matches.length ? 'Conflicting or missing DropX identity' : 'Unmapped';
      if(num(row.total_activity)>0) gap(row.mapping_status,row.station_code,row.work_date,row.provider_employee_id,row.provider_employee_name??'','',num(row.total_delivery));
      continue;
    }
    const worker=matches[0].worker!;
    row.dropx_name=worker.full_name;row.dropx_emp_code=worker.dropx_id;
    const k=`${worker.id}|${row.work_date}`, g=groups.get(k)??{worker,date:row.work_date,rows:[],maps:[]};
    g.rows.push(row);g.maps.push(...matches);groups.set(k,g);
  }
  // Monthly commitments accrue even when the provider upload has no row for a worker.
  for(const m of mappings) {
    if(!m.worker || !configured(m)) continue;
    const cs=components.get(m.payment_method_id)??[];
    const monthly=cs.some(c=>c.component_type!=='production' && (/month/i.test(c.pay_schedule??'') || c.calculation_type==='fixed_monthly')) || /month/i.test(m.guarantee_schedule??'');
    if(!monthly) continue;
    for(const date of dates) {
      if(!activeOn(m,date) || !employedOn(m.worker,date)) continue;
      const k=`${m.worker.id}|${date}`;
      if(groups.has(k)) continue;
      const station=stationById.get(m.station_id ?? m.worker.location_id)?.station_code;
      if(!station) continue;
      const row={id:`fixed:${m.worker.id}:${date}`,client:'Amazon',work_date:date,station_code:station,provider_employee_id:m.provider_member_id,provider_employee_name:m.worker.full_name,dropx_name:m.worker.full_name,dropx_emp_code:m.worker.dropx_id,pay_type:m.pay_type,total_delivery:0,total_activity:0,c_return:0,mfn:0,mfn_return:0,variable_pay:0,mg_pay:0,fuel_pay:0,van_pay:0,da_total_pay:0,mapping_status:'Mapped'};
      associates.push(row); groups.set(k,{worker:m.worker,date,rows:[row],maps:[m]});
    }
  }
  const people=new Map<string,CpsPersonCost>();
  const employeeCostDays=new Set<string>();
  // Canonical employee CTC replaces fixed DA components for that employee, so it cannot be counted twice.
  for(const e of facts.employees) for(const date of dates) {
    if(!employedOn(e,date)) continue;
    const salary=facts.salaries.filter(s=>s.employee_id===e.id && activeOn(s,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    if(salary?.monthly_ctc!=null) employeeCostDays.add(`${e.id}|${date}`);
  }
  for(const g of groups.values()) {
    // A single effective card belongs to the DropX identity; multiple provider IDs share fixed pay once.
    const candidates=mappings.filter(m=>m.worker?.id===g.worker.id && activeOn(m,g.date) && configured(m));
    const latest=candidates.sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    const current=latest ? candidates.filter(m=>m.effective_from===latest.effective_from) : [];
    const conflict=new Set(current.map(rateSignature)).size>1;
    const card=latest;
    const cs=card ? components.get(card.payment_method_id)??[] : [];
    const aggregate:RecordRow={client:g.rows[0].client};
    for(const field of ['amazon_delivery','swa_delivery','total_delivery','total_activity','c_return','mfn','mfn_return']) aggregate[field]=g.rows.reduce((n,r)=>n+num(r[field]),0);
    const costs=card ? calculateRateCard(card,cs,aggregate,g.date,true) : {salary:0,variable:0,fuel:0,van:0,missing:true};
    const issue=conflict ? 'Conflicting rate cards' : !card ? 'Payment setup missing' : costs.missing ? 'Rate values or production source missing' : '';
    if(issue) {
      for(const row of g.rows) {row.mapping_status=issue;gap(issue,row.station_code,g.date,row.provider_employee_id,g.worker.full_name,g.worker.dropx_id,num(row.total_delivery));}
      continue;
    }
    if(g.worker.source_profile_type==='employee' && employeeCostDays.has(`${g.worker.source_profile_id}|${g.date}`)) costs.salary=0;
    const volumes=new Map<string,number>();g.rows.forEach(r=>volumes.set(r.station_code,(volumes.get(r.station_code)??0)+num(r.total_delivery)));
    const salaryByStation=allocateCost(costs.salary,[...volumes.keys()],volumes);
    const vanByStation=allocateCost(costs.van,[...volumes.keys()],volumes);
    const fuelFixed=costs.fuel-g.rows.reduce((n,r)=>n+(card?calculateRateCard(card,cs,r,g.date,false).fuel:0),0);
    const fuelByStation=allocateCost(fuelFixed,[...volumes.keys()],volumes);
    const seenStations=new Set<string>();
    for(const row of g.rows) {
      const variable=calculateRateCard(card!,cs,row,g.date,false);
      const first=!seenStations.has(row.station_code);seenStations.add(row.station_code);
      row.variable_pay=variable.variable;row.mg_pay=first?salaryByStation.get(row.station_code)??0:0;
      row.fuel_pay=variable.fuel+(first?fuelByStation.get(row.station_code)??0:0);
      row.van_pay=first?vanByStation.get(row.station_code)??0:0;
      row.da_total_pay=row.variable_pay+row.mg_pay+row.fuel_pay;row.pay_type=card!.pay_type;row.mapping_status='Mapped';
      add(row.station_code,g.date,'DA','Salary / minimum guarantee',row.mg_pay,'Workforce rate card');
      add(row.station_code,g.date,'DA','Variable delivery pay',row.variable_pay,'Workforce rate card');
      add(row.station_code,g.date,'DA','DA fuel',row.fuel_pay,'Workforce rate card');
      add(row.station_code,g.date,'Van','Vehicle rent in rate card',row.van_pay,'Workforce rate card');
      const k=`${g.worker.id}|${row.station_code}`,p=people.get(k)??{id:g.worker.id,dropx_id:g.worker.dropx_id,name:g.worker.full_name,station_code:row.station_code,salary:0,variable:0,fuel:0,van:0,deliveries:0,paid_days:0,zero_delivery_days:0};
      p.salary+=row.mg_pay;p.variable+=row.variable_pay;p.fuel+=row.fuel_pay;p.van+=row.van_pay;p.deliveries+=num(row.total_delivery);
      if(first){p.paid_days++;if((volumes.get(row.station_code)??0)===0 && costs.salary>0)p.zero_delivery_days++;}people.set(k,p);
    }
  }
  // Every current workforce identity needs a provider link, including people yet to appear in uploads.
  const through=dates.at(-1);
  if(through) for(const w of facts.workforce) {
    const station=stationById.get(w.location_id)?.station_code;
    if(!station || !selected.has(station) || !employedOn(w,through)) continue;
    const current=mappings.filter(m=>m.worker?.id===w.id && activeOn(m,through));
    if(!current.some(m=>key(m.provider_member_id))) gap('Provider ID not linked',station,through,'',w.full_name,w.dropx_id);
    else if(!current.some(configured) && ![...gaps.values()].some(g=>g.dropx_id===w.dropx_id && g.kind==='Payment setup missing')) gap('Payment setup missing',station,through,current[0].provider_member_id,w.full_name,w.dropx_id);
  }
  const staffed=new Set<string>(),missingCtc=new Set<string>();
  const operating=facts.stations.filter(s=>s.is_active && !s.hide_from_location_list && !/^HO(?:_|$)/.test(s.station_code));
  for(const e of facts.employees) for(const date of dates) {
    if(!employedOn(e,date)) continue;
    const home=stationById.get(e.location_id);
    const rules=facts.people_rules.filter(r=>r.employee_id===e.id && activeOn(r,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from));
    const rule=rules[0];
    const overhead=/^HO(?:_|$)/.test(home?.station_code??'') || ['CLM','AOM','TC','RM','CM','NH','PGM','BH','CT','HRE','HRM','FINMGR','FLTM'].includes(e.designation);
    let codes:string[]=rule?.station_codes??[];
    let head:CpsHead=rule?.head ?? (overhead?'Overhead':e.designation==='DR'?'Van':['DA','DCD','ODCD','WM','PTDA'].includes(e.designation)?'DA':'UTR');
    if(!rule) {
      if(!overhead) codes=home?[home.station_code]:[];
      else {
        codes=operating.filter(s=>(e.location_scope_ids??[]).includes(s.id)).map(s=>s.station_code);
        if(!codes.length && e.email) codes=operating.filter(s=>[s.cluster_manager_email,s.ops_manager_email].some(v=>key(v)===key(e.email))).map(s=>s.station_code);
        if(!codes.length && home?.station_code==='HO') codes=operating.map(s=>s.station_code);
        if(!codes.length && (home?.region || home?.state)) codes=operating.filter(s=>home.region?key(s.region)===key(home.region):key(s.state)===key(home.state)).map(s=>s.station_code);
        if(!codes.length && home?.station_code==='HO') codes=operating.map(s=>s.station_code);
      }
    }
    if(!codes.length) {
      // Report at the employee's home location when no verified allocation group exists.
      if(home) gap('Overhead allocation missing',home.station_code,date,'',e.full_name,e.employee_code,0,0,'People / Finance');
      continue;
    }
    if(!codes.some(c=>selected.has(c))) continue;
    const salary=facts.salaries.filter(s=>s.employee_id===e.id && activeOn(s,date)).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    if(!salary || salary.monthly_ctc==null || num(salary.monthly_ctc)<=0) {
      for(const c of codes) {missingCtc.add(`${c}|${date}`);gap('People CTC missing',c,date,'',e.full_name,e.employee_code,0,0,'People / Finance');}continue;
    }
    const shares=allocateCost(monthlyAccrual(num(salary.monthly_ctc),date),codes,dailyVolumes.get(date)??new Map(),rule?.allocation??(overhead?'delivery_share':'equal'));
    for(const [station,amount] of shares) {
      if(head==='UTR')staffed.add(`${station}|${date}`);
      add(station,date,head,rule?.sub_head||rule?.label||(head==='Overhead'?`${e.designation || 'Shared staff'} CTC`:head==='DA'?'Salary / minimum guarantee':head==='Van'?'Van driver CTC':'Station staff CTC'),amount,'People CTC');
      if(head==='DA' && selected.has(station)) {
        const w=facts.workforce.find(w=>w.source_profile_type==='employee'&&w.source_profile_id===e.id);
        const k=`${w?.id??e.id}|${station}`,p=people.get(k)??{id:w?.id??e.id,dropx_id:e.employee_code,name:e.full_name,station_code:station,salary:0,variable:0,fuel:0,van:0,deliveries:0,paid_days:0,zero_delivery_days:0};
        p.salary+=amount;people.set(k,p);
      }
    }
  }
  for(const d of base.daily) {
    if(facts.rent_coverage && !facts.rent_coverage.some(r=>r.station_code===d.station_code && activeOn(r,d.work_date)) && !(facts.manual_inputs??[]).some(r=>r.head==='Rent' && r.station_codes.includes(d.station_code) && activeOn(r,d.work_date))) gap('Facility rent missing',d.station_code,d.work_date,'','','',0,0,'People / Finance');
    if(!d.shipment_present) gap('Shipment upload missing',d.station_code,d.work_date,'','','',0,0,'Operations uploads');
  }
  const daily=base.daily.map(d=>{
    const ledger=lines.filter(l=>l.station_code===d.station_code&&l.work_date===d.work_date);
    const sum=(head:string,sub?:string)=>ledger.filter(l=>l.head===head&&(!sub||l.sub_head===sub)).reduce((n,l)=>n+num(l.amount),0);
    const daBucket=(bucket:string)=>ledger.filter(l=>l.head==='DA' && (bucket==='salary'?/salary|minimum|guarantee|\bmg\b|fixed/i.test(l.sub_head):bucket==='fuel'?/fuel/i.test(l.sub_head):!/salary|minimum|guarantee|\bmg\b|fixed|fuel/i.test(l.sub_head))).reduce((n,l)=>n+num(l.amount),0);
    const rows=associates.filter(r=>r.station_code===d.station_code&&r.work_date===d.work_date);
    const unresolved=rows.filter(r=>r.mapping_status!=='Mapped' && num(r.total_activity)>0);
    const dayGaps=[...gaps.values()].filter(g=>g.station_code===d.station_code&&g.first_date<=d.work_date&&g.last_date>=d.work_date);
    return {...d,da:sum('DA'),utr:sum('UTR'),van:sum('Van'),rent:sum('Rent'),overhead:sum('Overhead'),other:sum('Other'),
      da_salary:daBucket('salary'),da_variable:daBucket('variable'),da_fuel:daBucket('fuel'),
      total:ledger.reduce((n,l)=>n+num(l.amount),0),unmapped:unresolved.length,unpaid:0,
      exposed_deliveries:unresolved.reduce((n,r)=>n+num(r.total_delivery),0),cost_gaps:dayGaps.length,
      utr_configured:!missingCtc.has(`${d.station_code}|${d.work_date}`)&&(staffed.has(`${d.station_code}|${d.work_date}`)||d.utr_configured)};
  });
  return {...base,daily,breakup:lines,associates:associates.filter(r=>selected.has(r.station_code)),gaps:[...gaps.values()].sort((a,b)=>b.deliveries-a.deliveries||a.first_date.localeCompare(b.first_date)),people:[...people.values()].filter(p=>selected.has(p.station_code)).sort((a,b)=>b.salary-a.salary)};
}
