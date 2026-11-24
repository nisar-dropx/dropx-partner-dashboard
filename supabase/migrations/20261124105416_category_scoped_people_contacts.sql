begin;
set local lock_timeout='5s';

-- Contacts may be shared across categories. New claims are unique only inside
-- one company/category. Leave grandfathered duplicates editable unless that
-- contact or its company changes. DropX/biometric identity guards are separate.
create or replace function public.enforce_category_people_contacts()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  n jsonb:=to_jsonb(new); o jsonb;
  company uuid:=(n->>'company_id')::uuid; profile uuid:=(n->>'id')::uuid;
  email text:=nullif(lower(btrim(n->>'email')),'');
  mobile text:=nullif(regexp_replace(coalesce(n->>'mobile',''),'[^0-9]','','g'),'');
  country text:=coalesce(nullif(regexp_replace(coalesce(n->>'mobile_country_code',''),'[^0-9]','','g'),''),'91');
  check_email boolean:=true; check_mobile boolean:=true;
  lock_key text; conflict boolean;
begin
  if tg_op='UPDATE' then
    o:=to_jsonb(old);
    check_email:=company is distinct from (o->>'company_id')::uuid
      or email is distinct from nullif(lower(btrim(o->>'email')),'');
    check_mobile:=company is distinct from (o->>'company_id')::uuid
      or mobile is distinct from nullif(regexp_replace(coalesce(o->>'mobile',''),'[^0-9]','','g'),'')
      or country is distinct from coalesce(nullif(regexp_replace(coalesce(o->>'mobile_country_code',''),'[^0-9]','','g'),''),'91');
  end if;
  if company is null then return new; end if;
  for lock_key in select k from unnest(array[
    case when check_email and email is not null then company::text||':'||tg_table_name||':email:'||email end,
    case when check_mobile and mobile is not null then company::text||':'||tg_table_name||':mobile:'||country||':'||mobile end
  ]) keys(k) where k is not null order by k loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_key,0));
  end loop;
  if check_email and email is not null then
    execute format('select exists(select 1 from %I.%I t where company_id=$1 and id is distinct from $2 and lower(btrim(email))=$3)',tg_table_schema,tg_table_name)
      into conflict using company,profile,email;
    if conflict then raise exception using errcode='23505',constraint='people_category_email_unique',message='Email is already registered in this category.'; end if;
  end if;
  if check_mobile and mobile is not null then
    execute format($query$select exists(select 1 from %I.%I t where company_id=$1 and id is distinct from $2
      and regexp_replace(coalesce(mobile,''),'[^0-9]','','g')=$3
      and coalesce(nullif(regexp_replace(coalesce(to_jsonb(t)->>'mobile_country_code',''),'[^0-9]','','g'),''),'91')=$4)$query$,tg_table_schema,tg_table_name)
      into conflict using company,profile,mobile,country;
    if conflict then raise exception using errcode='23505',constraint='people_category_mobile_unique',message='Mobile number is already registered in this category.'; end if;
  end if;
  return new;
end $$;
revoke all on function public.enforce_category_people_contacts() from public,anon,authenticated;

do $migration$
declare profile_table text;
begin
  for profile_table in
    select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace ns on ns.oid=c.relnamespace
    where ns.nspname='public' and c.relkind in ('r','p') and (
      c.relname in ('employees','contractors','workforce','helpers','vendors','workers','workforce_helpers','workforce_pickers')
      or c.relname in (select 'workforce_'||code from public.workforce_categories)
    ) and exists(select 1 from information_schema.columns col where col.table_schema='public' and col.table_name=c.relname and col.column_name='mobile')
      and exists(select 1 from information_schema.columns col where col.table_schema='public' and col.table_name=c.relname and col.column_name='email')
  loop
    execute format('drop trigger if exists a01_category_contacts on public.%I',profile_table);
    execute format('create trigger a01_category_contacts before insert or update on public.%I for each row execute function public.enforce_category_people_contacts()',profile_table);
  end loop;
end $migration$;
notify pgrst,'reload schema';
commit;
