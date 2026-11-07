import {readFileSync} from 'node:fs';
export async function testGuidedDisputes(db,{C,S,W2,A1,A2,A3,roles,ok,throws}) {
  const migration=readFileSync('supabase/migrations/20261107120000_guided_payout_disputes.sql','utf8');
  await db.exec(migration);await db.exec(migration);const zeroSource=readFileSync('supabase/migrations/20261107123000_dispute_zero_value_source_evidence.sql','utf8');await db.exec(zeroSource);await db.exec(zeroSource);ok('Guided migration is repeatable',true);
  const P='00000000-0000-0000-0000-000000000399';
  await db.query(`insert into workforce_payout_publications(id,company_id,workforce_id,station_id,revision,snapshot,published_at,period_start,period_end,publication_kind,review_until) values($1,$2,$3,$4,1,'{"item":{"net_amount":100}}',now(),'2026-11-01','2026-11-30','worksheet',now()+interval '2 days')`,[P,C,W2,S]);
  const claim=date=>({schema:3,issue:'attendance',component:'attendance',dates:[date],concern:'I worked but the day is missing'});
  const create=async detail=>(await db.query(`select workforce_raise_guided_payout_dispute($1,$2,$3,'training','Check this missing work day',$4) id`,[C,W2,P,JSON.stringify(detail)])).rows[0].id;
  const id=await create(claim('2026-11-01'));await create(claim('2026-11-02'));ok('Different dates can be disputed independently',true);
  try{await create(claim('2026-11-01'));ok('Overlapping date is blocked',false);}catch(e){ok('Overlapping date is blocked',/already covers/.test(e.message));}
  try{await create({...claim('2026-11-01'),issue:'salary',component:'earning:MONTHLY:0'});ok('Attendance and salary overlap is blocked',false);}catch(e){ok('Attendance and salary overlap is blocked',/already covers/.test(e.message));}
  try{await create(claim('2026-10-31'));ok('Out of period date is blocked',false);}catch(e){ok('Out of period date is blocked',/within this payout/.test(e.message));}
  const rolesSql=`array[${roles.map(r=>`'${r}'::uuid`).join(',')}]`;
  const row=(await db.query(`select * from workforce_dispute_transition_v3('${C}','${id}','${A1}','Reviewer',${rolesSql},'request_clarification',1,null,'{"note":"Please confirm which date you worked."}')`)).rows[0];
  ok('Clarification keeps dispute open and bank blocking',row.status==='open'&&row.details.awaiting_reply&&row.version===2);
  await db.query(`update workforce_payout_publications set review_until=now()-interval '1 day' where id=$1`,[P]);
  await db.query(`select workforce_reply_guided_dispute($1,$2,$3,2,'I worked on the first of November.')`,[C,W2,id]);
  const answered=(await db.query(`select * from workforce_payout_disputes where id=$1`,[id])).rows[0];
  ok('Existing clarification can be answered after submission window closes',!answered.details.awaiting_reply&&answered.version===3);
  await throws('Stale reply cannot overwrite history',`select workforce_reply_guided_dispute('${C}','${W2}','${id}',2,'Changed reply')`,/changed/);
  const snapshot={lines:[{work_date:'2026-11-01',calculation_snapshot:{workDayUnits:1,paymentLines:[{code:'DELIVERY',count:28,rate:10,amount:280}]}}],worksheet:{incentive_breakdown:[{code:'INCENTIVE',amount:0}],additional_payment_breakdown:[{code:'ALLOWANCE',amount:0}],deduction_breakdown:[{code:'LOSS_RECOVERY',amount:25,recoveryKey:'a'},{code:'LOSS_RECOVERY',amount:75,recoveryKey:'b'}]}};
  const value=async item=>(await db.query('select workforce_dispute_snapshot_value($1,$2) v',[JSON.stringify(snapshot),JSON.stringify(item)])).rows[0].v;
  ok('Known zero incentive remains verifiable',Number(await value({selector:'incentive',code:'INCENTIVE'}))===0);
  ok('Known zero allowance remains verifiable',Number(await value({selector:'addition',code:'ALLOWANCE'}))===0);
  ok('Closure identifies exact recovery allocation',Number(await value({selector:'deduction',code:'LOSS_RECOVERY',recovery_key:'a'}))===25);
  ok('Closure verifies dated attendance',Number(await value({selector:'attendance',date:'2026-11-01'}))===1);
  ok('Same amount in a different component cannot stand in for correction',await value({selector:'count',date:'2026-11-01',code:'PICKUP'})===null);
  const baseline={item:{net_amount:100},lines:[{work_date:'2026-11-01',calculation_snapshot:{workDayUnits:0}}]};
  await db.query('update workforce_payout_publications set snapshot=$1 where id=$2',[JSON.stringify(baseline),P]);
  const plan={schema:3,kind:'attendance',target_field:'Work day',current_value:0,proposed_value:1,expected_delta_paise:2500,claim:claim('2026-11-01'),items:[{selector:'attendance',date:'2026-11-01',code:'attendance',current_value:0,proposed_value:1,target_field:'Work day'}]};
  const step=async(actor,action,version,payload)=>(await db.query(`select * from workforce_dispute_transition_v3($1,$2,$3,'Reviewer',${rolesSql},$4,$5,null,$6)`,[C,id,actor,action,version,JSON.stringify(payload)])).rows[0];
  const proposed=await step(A1,'propose_correction',3,{note:'Delivery evidence confirms the missing day.',correction_plan:plan});
  const approved=await step(A2,'approve_final',proposed.version,{note:'Evidence checked independently.'});
  const processing=await step(A3,'claim_processing',approved.version,{note:'Applying the approved attendance correction.'});
  const P2='00000000-0000-0000-0000-000000000398';
  await db.query(`insert into workforce_payout_publications(id,company_id,workforce_id,station_id,revision,snapshot,published_at,period_start,period_end,publication_kind) values($1,$2,$3,$4,2,$5,clock_timestamp()+interval '1 second','2026-11-01','2026-11-30','worksheet')`,[P2,C,W2,S,JSON.stringify({...baseline,item:{net_amount:125}})]);
  const completion={note:'Corrected source verified against the revised publication.',processed_publication_id:P2,processing_result:{before_net_paise:10000,after_net_paise:12500}};
  try{await step(A3,'complete_processing',processing.version,completion);ok('Matching net change cannot close an unchanged attendance day',false);}catch(e){ok('Matching net change cannot close an unchanged attendance day',/approved correction/.test(e.message));}
  baseline.lines[0].calculation_snapshot.workDayUnits=1;baseline.item.net_amount=125;
  await db.query('update workforce_payout_publications set snapshot=$1 where id=$2',[JSON.stringify(baseline),P2]);
  const completed=await step(A3,'complete_processing',processing.version,completion);
  ok('Guided correction completes only with exact item and net evidence',completed.status==='resolved');
  const permissions=(await db.query(`select has_function_privilege('anon','workforce_dispute_transition_v3(uuid,uuid,uuid,text,uuid[],text,integer,uuid[],jsonb)','execute') anon,has_function_privilege('authenticated','workforce_reply_guided_dispute(uuid,uuid,uuid,integer,text)','execute') auth`)).rows[0];
  ok('Guided workflow RPCs remain service-only',!permissions.anon&&!permissions.auth);
}
