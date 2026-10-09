begin;

-- Existing worksheet publications predate the explicit bank-payment marker.
-- They were created only after the same publishability checks, so accept that
-- exact legacy snapshot shape through the bounded rollout cutoff. New snapshots
-- always carry an explicit true/false marker and therefore remain fail-closed.
do $migration$
declare
  v_signature regprocedure :=
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure;
  v_definition text;
  v_old text :=
    'latest.snapshot #>> ''{worksheet,payment_eligible}'' = ''true''';
  v_new text := $predicate$(
          latest.snapshot #>> '{worksheet,payment_eligible}' = 'true'
          or (
            latest.snapshot #> '{worksheet,payment_eligible}' is null
            and latest.snapshot #> '{worksheet,payment_details_available}' is null
            and latest.snapshot #> '{worksheet,payment_status}' is null
            and latest.published_at < '2026-10-10 00:00:00+00'::timestamptz
          )
        )$predicate$;
  v_matches integer;
begin
  select pg_get_functiondef(v_signature) into v_definition;

  if position(
    'latest.snapshot #> ''{worksheet,payment_details_available}'' is null'
    in v_definition
  ) > 0 then
    return;
  end if;

  v_matches := (
    length(v_definition) - length(replace(v_definition, v_old, ''))
  ) / length(v_old);
  if v_matches <> 3 then
    raise exception
      'Expected three legacy payment eligibility predicates, found %.',
      v_matches;
  end if;

  execute replace(v_definition, v_old, v_new);

  select pg_get_functiondef(v_signature) into v_definition;
  if position(
    'latest.snapshot #> ''{worksheet,payment_details_available}'' is null'
    in v_definition
  ) = 0 then
    raise exception 'Legacy publication compatibility was not installed.';
  end if;
end
$migration$;

comment on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[]) is
  'Canonical service-only Workforce bank-payment preview/creation calculator. Explicit eligibility is required for new publications; bounded pre-marker worksheet snapshots remain compatible.';

notify pgrst, 'reload schema';

commit;
