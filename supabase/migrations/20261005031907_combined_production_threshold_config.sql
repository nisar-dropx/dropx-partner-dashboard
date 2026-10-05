alter table public.payment_methods
  add column if not exists production_threshold_config jsonb;

comment on column public.payment_methods.production_threshold_config is
  'Optional combined production minimum rule. Shape: {"period":"day"|"month","component_codes":[...]}. The numeric minimum is stored per person in the effective-dated provider mapping snapshot.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_methods_production_threshold_config_check'
      and conrelid = 'public.payment_methods'::regclass
  ) then
    alter table public.payment_methods
      add constraint payment_methods_production_threshold_config_check
      check (
        production_threshold_config is null
        or (
          jsonb_typeof(production_threshold_config) = 'object'
          and production_threshold_config ? 'period'
          and production_threshold_config ? 'component_codes'
          and production_threshold_config ->> 'period' in ('day', 'month')
          and jsonb_typeof(production_threshold_config -> 'component_codes') = 'array'
          and jsonb_array_length(production_threshold_config -> 'component_codes') > 0
          and not jsonb_path_exists(
            production_threshold_config -> 'component_codes',
            '$[*] ? (@.type() != "string")'
          )
        )
      );
  end if;
end $$;

notify pgrst, 'reload schema';
