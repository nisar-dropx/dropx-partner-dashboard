import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const c = "00000000-0000-0000-0000-000000000001",
  loc = "00000000-0000-0000-0000-000000000002",
  person = "00000000-0000-0000-0000-000000000003",
  audit = "00000000-0000-0000-0000-000000000004";
test("migration is idempotent, preserves master edits, isolates data and locks evidence after submission", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
create table companies(id uuid primary key);create table stations(id uuid primary key);create table profiles(id uuid primary key);
create table location_models(id uuid primary key,company_id uuid,code text);create table ops_audit_programme_settings(company_id uuid,scheduler_role_ids uuid[],responder_role_ids uuid[]);
create table app_pages(id uuid primary key default gen_random_uuid(),company_id uuid,code text,name text,sort_order int,is_active bool,unique(company_id,code));
create table role_page_permissions(company_id uuid,role_id uuid,page_id uuid,can_view bool,can_add bool,can_edit bool,unique(company_id,role_id,page_id));
insert into companies values('${c}');insert into stations values('${loc}');insert into profiles values('${person}');insert into location_models values(gen_random_uuid(),'${c}','NOW');
insert into ops_audit_programme_settings values('${c}',array['${person}'::uuid],array['${loc}'::uuid]);
insert into app_pages(company_id,code,name,is_active) values('${c}','station_audits','Audits',true),('${c}','station_audit_master','Master',true);
insert into role_page_permissions select '${c}','${person}',id,true,true,true from app_pages;`);
    const sql = readFileSync(
      "supabase/migrations/20261015083000_dark_store_audits.sql",
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const master = (await db.query("select * from ops_store_audit_master"))
      .rows[0];
    assert.equal(master.template.sections.length, 8);
    assert.equal(
      master.template.sections.flatMap((s) => s.questions).length,
      46,
    );
    assert.equal(master.settings.modelIds.length, 1);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from role_page_permissions r join app_pages p on p.id=r.page_id where p.code like 'store_%' and r.can_edit",
        )
      ).rows[0].n,
      2,
    );
    for (const table of [
      "ops_store_audit_master",
      "ops_store_audits",
      "ops_store_audit_evidence",
    ]) {
      assert.equal(
        (
          await db.query(
            `select has_table_privilege('authenticated','${table}','SELECT') as allowed`,
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await db.query(
            `select relrowsecurity from pg_class where relname='${table}'`,
          )
        ).rows[0].relrowsecurity,
        true,
      );
    }
    await db.exec(
      `update ops_store_audit_master set version=2,template=jsonb_set(template,'{name}','"Edited checklist"');`,
    );
    await db.exec(sql);
    assert.equal(
      (await db.query("select version from ops_store_audit_master")).rows[0]
        .version,
      2,
    );
    await db.exec(
      `insert into ops_store_audits(id,company_id,number,location_id,store_name,assigned_to,assigned_name,scheduled_for,template,template_version,status) select '${audit}','${c}','STORE-TEST','${loc}','Fixture store','${person}','Auditor',now(),jsonb_build_object('sections',jsonb_build_array(jsonb_build_object('questions',jsonb_build_array(template->'sections'->0->'questions'->0)))),version,'in_progress' from ops_store_audit_master;`,
    );
    const insert = (phase, id, path) =>
      db.query(
        `insert into ops_store_audit_evidence(id,company_id,audit_id,question_id,phase,file_name,content_type,size,path,ready,uploaded_by) values($1,$2,$3,'priority_01',$4,'proof.png','image/png',100,$5,true,$6)`,
        [id, c, audit, phase, path, person],
      );
    await insert("audit", "00000000-0000-0000-0000-000000000010", "proof");
    await assert.rejects(
      insert(
        "response",
        "00000000-0000-0000-0000-000000000011",
        "response-before",
      ),
      /locked/,
    );
    await db.exec(
      `update ops_store_audits set summary='Fixture observation',answers='{"priority_01":{"outcome":"gap"}}',completed_at=now(),status='awaiting_response',findings='[{"questionId":"priority_01","state":"open"}]' where id='${audit}';`,
    );
    await assert.rejects(
      insert("audit", "00000000-0000-0000-0000-000000000012", "after-complete"),
      /locked/,
    );
    await assert.rejects(
      db.exec(`delete from ops_store_audit_evidence where path='proof'`),
      /locked/,
    );
    await insert(
      "response",
      "00000000-0000-0000-0000-000000000013",
      "closure-proof",
    );
    await db.exec(
      `update ops_store_audits set findings='[{"questionId":"priority_01","state":"submitted","note":"Fixed"}]',status='under_review' where id='${audit}';`,
    );
    await assert.rejects(
      insert(
        "response",
        "00000000-0000-0000-0000-000000000014",
        "after-response",
      ),
      /locked/,
    );
  } finally {
    await db.close();
  }
});
