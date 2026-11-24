import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export async function verifySelectedPeriodBankPayments(db, context) {
  const { audience, company, actor, bank, station } = context;
  if (audience === 'workforce') await db.exec(`
    create view public.workforce_payout_effective_paid_allocations as
    select i.company_id,i.workforce_id credited_workforce_id,a.station_id,i.period_start,i.period_end,
      a.instruction_amount_snapshot settled_amount_snapshot
    from public.workforce_payout_payment_items i join public.workforce_payout_payment_allocations a
      on a.company_id=i.company_id and a.payment_item_id=i.id where i.status='paid';
  `);
  const migration=readFileSync(new URL('../supabase/migrations/20261124132000_selected_period_bank_payments.sql',import.meta.url),'utf8');
  await db.exec(migration); await db.exec(migration);
  const subject=audience==='helpers'?'10000000-0000-4000-8000-000000000020':'90000000-0000-4000-8000-000000000001';
  const periods=[['2027-01-01','2027-01-15'],['2027-01-16','2027-01-31'],['2027-01-10','2027-01-20'],['2027-01-01','2027-01-31'],['2027-03-28','2027-04-04'],['2027-05-05','2027-05-05']];
  if(audience==='workforce') {
    await db.query(`insert into public.workforce(id,company_id,dropx_id,full_name,email,location_id,bank_account_no,ifsc_code)
      values($1,$2,'RANGE901','Range Test','range@example.test',$3,'1234567890','FDRL0000002')`,[subject,company,station]);
    await db.query(`insert into public.connect_profile_verifications(company_id,profile_type,account_id,kind,verified)
      values($1,'workforce',$2,'pan_aadhaar',true)`,[company,subject]);
    for(const [start,end] of periods) {
      const relock=(await db.query(`insert into public.workforce_payout_mapping_relocks(id,company_id,period_start,period_end,affected_workforce_ids,active_locations)
        values(gen_random_uuid(),$1,$2,$3,array[$4::uuid],$5::jsonb) returning id`,[company,start,end,subject,JSON.stringify({[subject]:[station]})])).rows[0].id;
      const snapshot={schema_version:'2',source:'workforce_payout_worksheet',worksheet:{payment_eligible:true,payment_status:'Ready for review'},item:{workforce_id:subject,station_code:'NLRF',net_amount:'100.00'}};
      const review=(await db.query(`insert into public.workforce_payout_review_submissions(id,company_id,subject_type,subject_id,location_id,period_start,period_end,status,calculation_snapshot)
        values(gen_random_uuid(),$1,'workforce',$2,$3,$4,$5,'under_review',$6::jsonb) returning id`,[company,subject,station,start,end,JSON.stringify(snapshot)])).rows[0].id;
      await db.query(`insert into public.workforce_payout_publications(id,company_id,workforce_id,station_id,revision,snapshot,snapshot_hash,dependency_hash,mapping_relock_id,review_submission_id,publication_kind,period_start,period_end)
        values(gen_random_uuid(),$1,$2,$3,1,$4::jsonb,repeat('a',64),'dependency-september-2026',$5,$6,'worksheet',$7,$8)`,[company,subject,station,JSON.stringify(snapshot),relock,review,start,end]);
    }
  }
  const rows=JSON.stringify([{workforce_id:subject,station_id:station,current_target_amount:100,current_snapshot_hash:'c'.repeat(64),expected_dependency_hash:'f'.repeat(32),expected_source_change_id:'0'}]);
  const prefix=audience==='helpers'?'helper':'workforce';
  const create=async(start,end)=> (await db.query(`select public.${prefix}_create_payout_payment_row_batch($1,$2,gen_random_uuid(),repeat('d',64),$3,$4::date,$5::date,'2027-06-01'::date,$6::jsonb) result`,[company,actor,bank,start,end,rows])).rows[0].result;
  const preview=async(start,end)=>(await db.query(`select * from public.${prefix}_preview_payout_payment_rows($1,$2::date,$3::date,$4::jsonb)`,[company,start,end,rows])).rows[0];
  const references=[],instructions=[];
  for(const index of [0,1,4,5]) {
    const [start,end]=periods[index];
    const before=await preview(start,end);assert.equal(before.eligible,true,JSON.stringify(before));
    const batch=await create(start,end);assert.equal(batch.items.length,1);references.push(batch.items[0].reference_no);
    const items=await db.query(`select id,reference_no,bank_account_no_snapshot,ifsc_snapshot,period_start::text,period_end::text,instruction_amount from public.${prefix}_payout_payment_items where batch_id=$1`,[batch.batch_id]);
    instructions.push(items.rows[0]);
    assert.equal(items.rows[0].period_start,start);assert.equal(items.rows[0].period_end,end);assert.equal(Number(items.rows[0].instruction_amount),100);
    const download=(await db.query(`select public.${prefix}_get_payout_payment_redownload($1,array[$2::uuid],$3::date,$4::date) result`,[company,items.rows[0].id,start,end])).rows[0].result;
    assert.ok(JSON.stringify(download).includes(references.at(-1)));
    assert.equal((await preview(start,end)).eligible,false,'processing instruction must not be regenerated');
  }
  assert.equal(new Set(references).size,references.length,'adjacent cycles need unique bank references');
  for(const index of [2,3]) {
    const [start,end]=periods[index];
    assert.equal((await preview(start,end)).eligibility_code,'overlapping_payment_period');
    await assert.rejects(create(start,end),/overlapping date range/i);
  }
  const first=instructions[0];
  const response=[{row_number:2,reference_no:first.reference_no,credit_account:first.bank_account_no_snapshot,ifsc:first.ifsc_snapshot,debit_amount_paise:10000,status:'PAID',utr_cin:'RANGE'+randomBytes(8).toString('hex').toUpperCase(),remarks:'Range test paid'}];
  const finalized=(await db.query(`select public.${prefix}_finalize_payout_payment_response($1,$2,gen_random_uuid(),$3,'range-test.xlsx',$4::jsonb) result`,[company,actor,randomBytes(32).toString('hex'),JSON.stringify(response)])).rows[0].result;
  assert.equal(finalized.paid,1,JSON.stringify(finalized));
  assert.equal(Number((await preview(...periods[0])).paid_amount),100);
  assert.equal(Number((await preview(...periods[0])).balance_payable),0);
  assert.equal((await preview(...periods[2])).eligibility_code,'overlapping_payment_period','paid period must also block overlap');
  const cancelled=instructions[2];
  await db.query(`select public.${prefix}_transition_payout_payment_item($1,$2,gen_random_uuid(),$3,'cancelled','Range test cancelled')`,[company,actor,cancelled.id]);
  assert.equal((await preview(...periods[4])).eligible,true,'cancellation must release the selected period');
  const retry=await create(...periods[4]);
  assert.notEqual(retry.items[0].reference_no,cancelled.reference_no,'retry uses a new reference version');
  const grants=(await db.query(`select has_function_privilege('authenticated','public.payout_bank_period_overlap(uuid,text,uuid,uuid,date,date)','EXECUTE') allowed`)).rows[0];
  assert.equal(grants.allowed,false);
  await assert.rejects(create('2027-08-20','2027-08-01'),/valid payout bank-payment date range/i);
  console.log(`${audience}: selected cycle, daily and cross-month bank creation, re-download, unique references and overlap rejection passed.`);
}
