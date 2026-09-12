// Run against a disposable embedded PostgreSQL instance, never production.
// EDD_TEST_PGLITE_MODULE points to an external pinned @electric-sql/pglite install.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.EDD_TEST_PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table public.edd_station_snapshots(station_code text primary key);
    create table public.edd_performance_snapshots(station_code text primary key);
    insert into edd_station_snapshots select 'S'||i from generate_series(1,38) i;
    grant select on edd_station_snapshots,edd_performance_snapshots to service_role;`);
  await db.exec(readFileSync(new URL('../supabase/migrations/20260912092525_review_edd_durable_source_refresh.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20260912094856_review_edd_refresh_completion_recovery.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20260912110718_review_edd_refresh_reuse_source_clock.sql',import.meta.url),'utf8'));
  const claim=async()=> (await db.query('select * from edd_claim_review_source($1)',[randomUUID()])).rows;
  const finish=async(job,error=null,token=job.lease_token)=>(await db.query('select edd_finish_review_source($1,$2,$3,$4,$5) as saved',[job.station_code,job.source,token,error?null:new Date().toISOString(),error])).rows[0].saved;
  await db.exec('set role service_role');
  const a=(await claim())[0], b=(await claim())[0];
  const repeatedClaim=(await db.query('select * from edd_claim_review_source($1)',[a.lease_token])).rows[0];
  assert.equal(repeatedClaim.station_code,a.station_code);
  assert.equal(repeatedClaim.attempts,1,'lost claim response returns the existing lease');
  assert.notEqual(a.station_code,b.station_code,'one station cannot race both feeds');
  assert.equal((await claim()).length,0,'two global lanes enforced by database');
  assert.equal((await db.query('select count(*)::int as n from ops_review_edd_refresh_jobs')).rows[0].n,76,'all 38 stations have both jobs');
  assert.equal(await finish(a,null,randomUUID()),false,'stale/wrong owner cannot finish');
  assert.equal(await finish(a),true);
  assert.equal(await finish(a),true,'lost completion response can be acknowledged twice');
  const done=(await db.query('select * from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[a.station_code,a.source])).rows[0];
  assert.ok(Date.parse(done.next_attempt_at)-Date.now()>14*60000,'success waits 15 minutes');
  assert.equal(await finish(b,'upstream_502'),true);
  assert.equal(await finish(b,'upstream_502'),true,'failed attempts are idempotent too');
  const failed=(await db.query('select * from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[b.station_code,b.source])).rows[0];
  assert.equal(failed.consecutive_failures,1);assert.equal(failed.last_error,'upstream_502');
  assert.ok(Date.parse(failed.next_attempt_at)-Date.now()>50000,'retry is persisted, not discarded');
  // Expired process lease is reclaimable. Prior source success remains intact.
  await db.query(`update ops_review_edd_refresh_jobs set next_attempt_at=now()+interval '1 hour'`);
  const oldToken=randomUUID();
  await db.query(`update ops_review_edd_refresh_jobs set next_attempt_at=now()-interval '1 minute',lease_token=$3,lease_until=now()-interval '1 second' where station_code=$1 and source=$2`,[a.station_code,a.source,oldToken]);
  const reclaimed=(await claim())[0];assert.equal(reclaimed.station_code,a.station_code);assert.notEqual(reclaimed.lease_token,oldToken);
  assert.equal(await finish(reclaimed,'timeout',oldToken),false);
  assert.equal(await finish(reclaimed,'timeout'),true);
  const retained=(await db.query('select * from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[a.station_code,a.source])).rows[0];
  assert.deepEqual(retained.source_at,done.source_at,'failed refresh retains previous successful source');
  assert.deepEqual(retained.last_success_at,done.last_success_at);
  // Reusing a 12-minute-old snapshot must be due in ~3 minutes, not 15.
  await db.query("update ops_review_edd_refresh_jobs set next_attempt_at=now()-interval '1 second' where station_code=$1 and source=$2",[a.station_code,a.source]);
  const cachedJob=(await claim())[0], originalAt=new Date(Date.now()-12*60000).toISOString();
  const args=[cachedJob.station_code,cachedJob.source,cachedJob.lease_token,originalAt,null];
  assert.equal((await db.query('select edd_finish_review_source($1,$2,$3,$4,$5) as saved',args)).rows[0].saved,true);
  const reused=(await db.query('select * from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[a.station_code,a.source])).rows[0];
  const exactSource=(await db.query('select source_at=$3::timestamptz as exact from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[a.station_code,a.source,originalAt])).rows[0].exact;
  assert.equal(exactSource,true,'source observation time is never rewritten as now');
  assert.ok(Date.parse(reused.next_attempt_at)-Date.now()<4*60000);
  assert.ok(Date.parse(reused.next_attempt_at)-Date.now()>2*60000);
  await db.query('select edd_finish_review_source($1,$2,$3,$4,$5)',args);
  const duplicate=(await db.query('select next_attempt_at from ops_review_edd_refresh_jobs where station_code=$1 and source=$2',[a.station_code,a.source])).rows[0];
  assert.deepEqual(duplicate.next_attempt_at,reused.next_attempt_at,'repeat acknowledgement cannot slide the cadence');
  for(const role of ['anon','authenticated']){
    await db.exec('reset role; set role '+role);
    await assert.rejects(()=>claim(),/permission denied/);
    await assert.rejects(()=>db.query('select * from ops_review_edd_refresh_jobs'),/permission denied/);
  }
  console.log('PASS PostgreSQL queue: actual migration, 76 jobs, global concurrency, token fencing, lease expiry, persistent backoff, retained successes, anon/auth denied.');
} finally { await db.close(); }
