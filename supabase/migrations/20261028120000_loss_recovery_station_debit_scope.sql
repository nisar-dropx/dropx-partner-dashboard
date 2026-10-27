begin;
-- Debit targets stop at Station Manager. Cluster / City / AOM stay out of the
-- recovery directory so location teams never see manager salaries. Ceiling at
-- STM stops the reporting walk before Cluster Manager.
update nl_loss_sources set recovery_policy = jsonb_set(
  jsonb_set(
    jsonb_set(
      recovery_policy,
      '{directory_ceiling_designations}',
      '["STM"]'::jsonb
    ),
    '{directory_excluded_designations}',
    (
      select coalesce(jsonb_agg(to_jsonb(code) order by code), '[]'::jsonb)
      from (
        select distinct upper(code) code
        from (
          select jsonb_array_elements_text(
            coalesce(recovery_policy->'directory_excluded_designations', '[]'::jsonb)
          ) code
          union all
          select unnest(array[
            'CM','CLM','AOM','BH','RH','RM','ZH','NH','GM','HLM','HRM',
            'SLPM','FINMGR','MP','MANAGING_PARTNER','OWNER'
          ])
        ) s
        where nullif(trim(code), '') is not null
      ) d
    )
  ),
  '{eligible_designations}',
  coalesce(
    (
      select jsonb_agg(to_jsonb(name) order by name)
      from (
        select distinct name
        from jsonb_array_elements_text(
          coalesce(recovery_policy->'eligible_designations', '[]'::jsonb)
        ) name
        where lower(name) not in (
          'cluster manager',
          'area operations manager',
          'area operation manager',
          'city manager'
        )
      ) e
    ),
    '[]'::jsonb
  )
);

commit;
