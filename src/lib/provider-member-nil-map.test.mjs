import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('Nill Map persists without a person, enforces scope, reverses and clears on a real link',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create schema auth;create role anon;create role authenticated;create role service_role bypassrls;
      create table auth.users(id uuid primary key);
      create table companies(id uuid primary key);
      create table providers(id uuid primary key,company_id uuid);
      create table stations(id uuid primary key,company_id uuid,provider_id uuid,station_code text);
      create table workforce(id uuid primary key,company_id uuid,location_id uuid,provider_employee_id text,deleted_at timestamptz);
      create table cps_shipment_daily(company_id uuid,station_code text,provider_employee_id text);
      create table field_executive_provider_mappings(id uuid primary key default gen_random_uuid(),company_id uuid,provider_id uuid,station_id uuid,provider_member_id text,workforce_id uuid,status text,effective_to date);
      create function lock_workforce_payment_allocation_company(uuid) returns void language sql as $$select$$;
    `);
    const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const [company,actor,provider,station,otherStation,otherCompany]=[1,2,3,4,5,6].map(id);
    await db.query('insert into companies values($1),($2)',[company,otherCompany]);
    await db.query('insert into auth.users values($1)',[actor]);
    await db.query('insert into providers values($1,$2)',[provider,company]);
    await db.query("insert into stations values($1,$2,$3,'AAA'),($4,$2,$3,'BBB')",[station,company,provider,otherStation]);
    await db.query("insert into cps_shipment_daily values($1,'AAA',' Member01 '),($1,'BBB','MEMBER01')",[company]);
    const migration=readFileSync(new URL('../../supabase/migrations/20261125060532_provider_member_nil_maps.sql',import.meta.url),'utf8');
    await db.exec(migration);await db.exec(migration);
    const roleFix=readFileSync(new URL('../../supabase/migrations/20261125061932_provider_nil_map_service_role_access.sql',import.meta.url),'utf8');
    await db.exec(roleFix);await db.exec(roleFix);
    const primaryKeyFix=readFileSync(new URL('../../supabase/migrations/20261125062559_provider_nil_map_primary_key.sql',import.meta.url),'utf8');
    await db.exec(primaryKeyFix);await db.exec(primaryKeyFix);
    const remarksMigration=readFileSync(new URL('../../supabase/migrations/20261125072200_provider_nil_map_remarks.sql',import.meta.url),'utf8');
    await db.exec(remarksMigration);await db.exec(remarksMigration);
    const primaryKey=(await db.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='provider_member_nil_maps'::regclass and contype='p'")).rows[0].definition;
    assert.equal(primaryKey,'PRIMARY KEY (id)','no unintended stations/providers many-to-many relationship may be inferred');
    await db.exec('grant usage on schema auth to service_role;grant select on companies,providers,stations,workforce,cps_shipment_daily,field_executive_provider_mappings to service_role;');
    const save=async(value=true,scope=[station],member='member01',stationId=station,companyId=company)=>{
      await db.exec('set role service_role;');
      try {return await db.query('select provider_set_member_nil_map($1,$2,$3,$4,$5,$6,$7::uuid[]) result',[companyId,actor,provider,stationId,member,value,scope]);}
      finally {await db.exec('reset role;');}
    };
    assert.equal((await save()).rows[0].result.nil_mapped,true);
    await save();
    assert.deepEqual((await db.query('select provider_member_id,station_id from provider_member_nil_maps')).rows,[{provider_member_id:'MEMBER01',station_id:station}]);
    assert.equal((await db.query('select count(*)::int n from workforce')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from field_executive_provider_mappings')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from provider_member_nil_map_events')).rows[0].n,1,'retry does not duplicate audit');
    const remark=async text=>{
      await db.exec('set role service_role;');
      try{return await db.query('select provider_set_member_nil_map($1,$2,$3,$4,$5,true,$6::uuid[],$7) result',[company,actor,provider,station,'MEMBER01',[station],text]);}
      finally{await db.exec('reset role;');}
    };
    await remark('  Absconded before registration  ');
    await remark('Absconded before registration');
    assert.equal((await db.query('select remark from provider_member_nil_maps where station_id=$1',[station])).rows[0].remark,'Absconded before registration');
    assert.equal((await db.query("select count(*)::int n from provider_member_nil_map_events where action='remark_updated'")).rows[0].n,1);
    await remark('Not registered');
    assert.equal((await db.query('select remark from provider_member_nil_maps where station_id=$1',[station])).rows[0].remark,'Not registered');
    await assert.rejects(remark('x'.repeat(2001)),/2000 characters/);
    await save();
    assert.equal((await db.query('select remark from provider_member_nil_maps where station_id=$1',[station])).rows[0].remark,'Not registered','older worksheets do not erase the remark');
    await assert.rejects(save(true,[]),/outside your allocated/);
    await assert.rejects(save(true,[otherStation]),/outside your allocated/);
    await assert.rejects(save(true,[station],'MEMBER01',station,otherCompany),/location is unavailable/);
    await assert.rejects(save(true,[station],'UNKNOWN'),/not in the selected location activity/);
    await assert.rejects(save(true,[station],'1.234e+12'),/exact Provider Member ID/);
    await save(true,[otherStation],'MEMBER01',otherStation);
    await save(false);
    assert.equal((await db.query('select count(*)::int n from provider_member_nil_maps')).rows[0].n,1,'clear leaves the other station alone');
    await save();
    await db.query("insert into field_executive_provider_mappings(company_id,provider_id,station_id,provider_member_id,workforce_id,status) values($1,$2,$3,'MEMBER01',$4,'active')",[company,provider,station,id(7)]);
    assert.equal((await db.query('select count(*)::int n from provider_member_nil_maps where station_id=$1',[station])).rows[0].n,0,'real mapping resolves nil marker');
    await assert.rejects(save(),/already has a registered associate or mapping/);
    await db.query('insert into workforce values($1,$2,$3,$4,null)',[id(8),company,otherStation,'MEMBER01']);
    await assert.rejects(save(true,[otherStation],'MEMBER01',otherStation),/already has a registered associate or mapping/);
    const security=(await db.query(`select has_function_privilege('authenticated','provider_set_member_nil_map(uuid,uuid,uuid,uuid,text,boolean,uuid[])','execute') can_call,
      has_table_privilege('authenticated','provider_member_nil_maps','insert') can_insert,
      (select relrowsecurity from pg_class where oid='provider_member_nil_maps'::regclass) rls`)).rows[0];
    assert.deepEqual(security,{can_call:false,can_insert:false,rls:true});
    assert.equal((await db.query("select has_table_privilege('service_role','auth.users','select') allowed")).rows[0].allowed,false,'saving does not require private auth table access');
  } finally {await db.close();}
});
