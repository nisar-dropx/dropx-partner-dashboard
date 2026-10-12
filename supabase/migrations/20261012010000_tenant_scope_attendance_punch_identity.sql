-- Biometric devices and enrolment numbers are tenant-scoped. All current
-- writers therefore use the company-scoped punch identity below.
create unique index if not exists attendance_punches_company_device_enrol_time_uidx
  on public.attendance_punches (
    company_id,
    device_serial,
    enrolment_id,
    punch_time
  );

-- IF NOT EXISTS alone would accept an unrelated object that happened to reuse
-- the expected name. Prove the arbiter is valid and exactly tenant-scoped
-- before relaxing the obsolete global rule.
do $$
declare
  index_columns text[];
  index_is_ready boolean;
  index_is_unique boolean;
  index_is_valid boolean;
  index_is_unconditional boolean;
begin
  select
    array_agg(attribute.attname::text order by key.ordinality)
      filter (where key.ordinality <= index_meta.indnkeyatts),
    index_meta.indisready,
    index_meta.indisunique,
    index_meta.indisvalid,
    index_meta.indpred is null and index_meta.indexprs is null
  into
    index_columns,
    index_is_ready,
    index_is_unique,
    index_is_valid,
    index_is_unconditional
  from pg_catalog.pg_class index_class
  join pg_catalog.pg_namespace index_namespace
    on index_namespace.oid = index_class.relnamespace
  join pg_catalog.pg_index index_meta
    on index_meta.indexrelid = index_class.oid
  cross join lateral unnest(index_meta.indkey::smallint[]) with ordinality
    as key(attnum, ordinality)
  left join pg_catalog.pg_attribute attribute
    on attribute.attrelid = index_meta.indrelid
   and attribute.attnum = key.attnum
  where index_namespace.nspname = 'public'
    and index_class.relname = 'attendance_punches_company_device_enrol_time_uidx'
    and index_meta.indrelid = 'public.attendance_punches'::regclass
  group by
    index_meta.indisready,
    index_meta.indisunique,
    index_meta.indisvalid,
    index_meta.indpred,
    index_meta.indexprs;

  if index_columns is distinct from array[
      'company_id',
      'device_serial',
      'enrolment_id',
      'punch_time'
    ]::text[]
    or index_is_ready is distinct from true
    or index_is_unique is distinct from true
    or index_is_valid is distinct from true
    or index_is_unconditional is distinct from true
  then
    raise exception
      'Cannot remove the legacy punch identity without the exact valid company-scoped unique index.';
  end if;
end
$$;

-- Some upgraded databases retained the original global uniqueness rule. It
-- rejects a valid punch when two companies use the same device serial,
-- enrolment number and timestamp. Remove either legacy representation only
-- after the company-scoped index above is available. Do not use CASCADE: an
-- unexpected dependency must stop the migration for review.
alter table public.attendance_punches
  drop constraint if exists attendance_punches_device_serial_enrolment_id_punch_time_key;

drop index if exists public.attendance_punches_device_serial_enrolment_id_punch_time_key;
