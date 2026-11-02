-- Preserve stored single-source rules; allow only validated sums of distinct source keys.
alter table public.payment_conversion_rate_rules drop constraint if exists payment_conversion_rate_rules_numerator_source_check;
alter table public.payment_conversion_rate_rules add constraint payment_conversion_rate_rules_numerator_source_check
  check (numerator_source ~ '^[a-z][a-z0-9_]*(\+[a-z][a-z0-9_]*)*$');
alter table public.payment_conversion_rate_rules drop constraint if exists payment_conversion_rate_rules_denominator_source_check;
alter table public.payment_conversion_rate_rules add constraint payment_conversion_rate_rules_denominator_source_check
  check (denominator_source ~ '^[a-z][a-z0-9_]*(\+[a-z][a-z0-9_]*)*$');

create or replace function public.validate_payment_conversion_rate_rule()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  tier jsonb;
  minimum_value numeric;
  rate_value numeric;
  previous_minimum numeric := -1;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Conversion rules are immutable. Create a new future-dated rule after the existing rule ends.';
  end if;
  if new.effective_from <= (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'Conversion rules must start after today to preserve current payments.';
  end if;
  if exists (
    select 1 from unnest(array[new.numerator_source, new.denominator_source]) expression
    where expression !~ '^[a-z][a-z0-9_]*(\+[a-z][a-z0-9_]*)*$'
      or cardinality(string_to_array(expression, '+')) <> (select count(distinct key) from unnest(string_to_array(expression, '+')) key)
      or exists (select 1 from unnest(string_to_array(expression, '+')) key
        where not exists (select 1 from public.payment_conversion_metric_options() m where m.source_key = key))
  ) then
    raise exception 'Select distinct valid numeric production inputs for each side of the conversion formula.';
  end if;
  if not exists (select 1 from public.payment_methods m join public.payment_method_components c
      on c.payment_method_id = m.id and c.company_id = m.company_id
      join public.payment_fields f on f.id = c.payment_field_id and f.company_id = m.company_id
      where m.id = new.payment_method_id and m.company_id = new.company_id and m.is_active
      and f.id = new.payment_field_id and f.is_active and f.field_type = 'production' and c.is_active) then
    raise exception 'Select an active production field belonging to this company and payment method.';
  end if;
  if not exists (select 1 from public.stations s join public.location_models m on m.id = s.location_model_id
      join public.providers p on p.id = m.provider_id
      where s.id = new.station_id and s.company_id = new.company_id
      and s.provider_id = new.provider_id and s.location_model_id = new.location_model_id
      and m.company_id = new.company_id and m.provider_id = new.provider_id and m.is_active
      and p.id = new.provider_id and p.company_id = new.company_id and p.is_active) then
    raise exception 'The location, model and provider must belong to the same company and scope.';
  end if;
  if jsonb_typeof(new.tiers) <> 'array' or jsonb_array_length(new.tiers) not between 1 and 20 then
    raise exception 'Enter between 1 and 20 conversion slabs.';
  end if;
  for tier in select value from jsonb_array_elements(new.tiers) loop
    if jsonb_typeof(tier->'minimum') is distinct from 'number' or jsonb_typeof(tier->'rate') is distinct from 'number' then
      raise exception 'Every slab requires a numeric minimum and rate.';
    end if;
    minimum_value := (tier->>'minimum')::numeric;
    rate_value := (tier->>'rate')::numeric;
    if minimum_value < 0 or minimum_value > 100 or rate_value < 0
      or minimum_value <= previous_minimum or (previous_minimum = -1 and minimum_value <> 0) then
      raise exception 'Slabs must start at 0, have ascending unique minimums up to 100 and non-negative rates.';
    end if;
    previous_minimum := minimum_value;
  end loop;
  -- Serializes competing inserts for the same exact rate scope.
  perform pg_advisory_xact_lock(hashtextextended(new.company_id::text || new.station_id::text
    || new.payment_method_id::text || new.payment_field_id::text, 0));
  if exists (select 1 from public.payment_conversion_rate_rules r where r.company_id = new.company_id
      and r.station_id = new.station_id and r.payment_method_id = new.payment_method_id
      and r.payment_field_id = new.payment_field_id
      and r.effective_from <= new.effective_to and r.effective_to >= new.effective_from) then
    raise exception 'A conversion rule already covers part of this date range for this method, field and location.';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_payment_conversion_rate_rule() from public, anon, authenticated;
