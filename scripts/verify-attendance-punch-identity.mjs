import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../supabase/migrations/20261012010000_tenant_scope_attendance_punch_identity.sql",
  import.meta.url
);

const db = new PGlite();
await db.exec(`
  create schema if not exists public;
  create table public.attendance_punches (
    id bigint generated always as identity primary key,
    company_id text not null,
    device_serial text not null,
    enrolment_id text not null,
    punch_time timestamptz not null,
    constraint attendance_punches_device_serial_enrolment_id_punch_time_key
      unique (device_serial, enrolment_id, punch_time)
  );
  create unique index attendance_punches_company_device_enrol_time_uidx
    on public.attendance_punches
      (company_id, device_serial, enrolment_id, punch_time);
`);

await db.exec(`
  insert into public.attendance_punches
    (company_id, device_serial, enrolment_id, punch_time)
  values ('company-a', 'serial-1', '42', '2026-09-01T03:30:00Z');
`);

await assert.rejects(
  db.exec(`
    insert into public.attendance_punches
      (company_id, device_serial, enrolment_id, punch_time)
    values ('company-b', 'serial-1', '42', '2026-09-01T03:30:00Z')
    on conflict (company_id, device_serial, enrolment_id, punch_time) do nothing;
  `),
  /attendance_punches_device_serial_enrolment_id_punch_time_key/
);

const migration = await readFile(migrationUrl, "utf8");
await db.exec(migration);
// Applying the migration again must remain harmless.
await db.exec(migration);

await db.exec(`
  insert into public.attendance_punches
    (company_id, device_serial, enrolment_id, punch_time)
  values ('company-b', 'serial-1', '42', '2026-09-01T03:30:00Z')
  on conflict (company_id, device_serial, enrolment_id, punch_time) do nothing;
  insert into public.attendance_punches
    (company_id, device_serial, enrolment_id, punch_time)
  values ('company-b', 'serial-1', '42', '2026-09-01T03:30:00Z')
  on conflict (company_id, device_serial, enrolment_id, punch_time) do nothing;
`);

const rows = await db.query(`
  select company_id
  from public.attendance_punches
  order by company_id;
`);
assert.deepEqual(rows.rows, [
  { company_id: "company-a" },
  { company_id: "company-b" }
]);

console.log("tenant-scoped attendance punch identity verified");
