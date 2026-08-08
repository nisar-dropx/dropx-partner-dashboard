-- PostgreSQL lpad truncates input when the requested length is shorter than
-- the input. Preserve every serial digit after the counter grows past the
-- configured minimum width (for example 1002 with minimum width 3).

create or replace function public.generate_configured_worker_id(
  p_company_id uuid,
  p_setting_type text,
  p_category text,
  p_location_id uuid default null,
  p_model_id uuid default null,
  p_designation_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_setting public.dropx_id_generation_settings%rowtype;
  selected_key text;
  selected_config jsonb;
  selected_prefix text;
  selected_separator text;
  selected_suffix text;
  selected_serial integer;
  selected_digits integer;
  serial_text text;
  generated_id text;
begin
  select * into selected_setting
  from public.dropx_id_generation_settings
  where company_id = p_company_id
    and setting_type = p_setting_type
    and is_active = true
  limit 1 for update;

  if not found then return null; end if;

  selected_key := case selected_setting.scope_type
    when 'designation' then p_designation_id::text
    when 'multi_designation' then (
      select entry.key
      from jsonb_each(selected_setting.configs) entry
      where entry.value -> 'designation_ids' ? p_designation_id::text
      limit 1
    )
    when 'location' then p_location_id::text
    when 'model' then p_model_id::text
    when 'company' then 'company'
    else p_category
  end;

  if selected_key is null or selected_key = '' then return null; end if;

  selected_config := selected_setting.configs -> selected_key;
  if selected_config is null then return null; end if;

  selected_prefix := nullif(selected_config ->> 'prefix', '');
  selected_separator := coalesce(selected_config ->> 'separator', '');
  selected_suffix := nullif(selected_config ->> 'suffix', '');
  selected_serial := greatest(coalesce((selected_config ->> 'next_serial_no')::integer, 1), 1);
  selected_digits := least(greatest(coalesce((selected_config ->> 'serial_digits')::integer, 3), 1), 12);
  serial_text := lpad(
    selected_serial::text,
    greatest(selected_digits, length(selected_serial::text)),
    '0'
  );
  generated_id := coalesce(selected_prefix, '') ||
    case when coalesce(selected_prefix, '') <> '' then selected_separator else '' end || serial_text ||
    case when coalesce(selected_suffix, '') <> '' then selected_separator || selected_suffix else '' end;

  update public.dropx_id_generation_settings
  set configs = case when selected_setting.scope_type = 'multi_designation' then
        jsonb_set(
          jsonb_set(configs, array[selected_key, 'next_serial_no'], to_jsonb(selected_serial + 1), true),
          array[selected_key, 'is_locked'], 'true'::jsonb, true
        )
      else jsonb_set(configs, array[selected_key, 'next_serial_no'], to_jsonb(selected_serial + 1), true)
      end,
      is_locked = true,
      updated_at = now()
  where id = selected_setting.id;

  return generated_id;
end;
$$;

