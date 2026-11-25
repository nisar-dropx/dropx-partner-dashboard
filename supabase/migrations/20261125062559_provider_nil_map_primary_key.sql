begin;
set local lock_timeout='5s';
-- This is a disposition record, not a stations/providers junction. PostgREST
-- infers many-to-many relationships when both FKs are in a composite PK,
-- which makes existing stations.providers embeds ambiguous across the app.
alter table public.provider_member_nil_maps add column if not exists id uuid not null default gen_random_uuid();
create unique index if not exists provider_member_nil_maps_identity_uidx
  on public.provider_member_nil_maps(company_id,provider_id,station_id,provider_member_id);
do $migration$
declare primary_constraint record;
begin
  select conname,pg_get_constraintdef(oid) as definition into primary_constraint
    from pg_constraint where conrelid='public.provider_member_nil_maps'::regclass and contype='p';
  if primary_constraint.definition='PRIMARY KEY (id)' then return; end if;
  if primary_constraint.conname is not null then
    execute format('alter table public.provider_member_nil_maps drop constraint %I',primary_constraint.conname);
  end if;
  alter table public.provider_member_nil_maps add constraint provider_member_nil_maps_pkey primary key(id);
end $migration$;
notify pgrst,'reload schema';
commit;
