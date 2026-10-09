begin;

-- Bank instructions pay the latest immutable worksheet publication, not a
-- newly calculated live worksheet. Publication/input refresh jobs and mapping
-- relocks are the serialized paths that replace that snapshot when a real
-- payout input or mapping changes. Comparing the publication's captured
-- dependency hash to the live company hash here defeated those semantics:
-- the live hash includes the current IST date and a company-wide revision, so
-- midnight or an unrelated profile write made every published month appear
-- stale even though no payout input changed.
--
-- Remove the live-hash prelude and the three identical eligibility filters
-- from the canonical candidate function. Preview and batch creation both
-- consume this function, so they continue to agree. The remaining gates still
-- require the complete latest publication set, immutable snapshot metadata,
-- an eligible review, no unfinished refresh, and no pending mapping relock.
do $patch$
declare
  v_definition text;
  v_predicate constant text := 'and latest.dependency_hash = v_current_dependency_hash';
  v_declaration constant text := 'v_current_dependency_hash text;';
  v_live_hash_guard_start constant text :=
    'v_current_dependency_hash := public.workforce_advance_recovery_snapshot_hash(';
  v_live_hash_guard_error constant text :=
    'The current Workforce payout dependency version is unavailable.';
  v_predicate_count integer;
  v_declaration_count integer;
  v_live_hash_guard_start_count integer;
  v_live_hash_guard_error_count integer;
  v_live_hash_guard_start_position integer;
  v_live_hash_guard_end_offset integer;
begin
  select pg_get_functiondef(
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure
  ) into v_definition;

  v_predicate_count := (
    length(v_definition) - length(replace(v_definition, v_predicate, ''))
  ) / length(v_predicate);
  v_declaration_count := (
    length(v_definition) - length(replace(v_definition, v_declaration, ''))
  ) / length(v_declaration);
  v_live_hash_guard_start_count := (
    length(v_definition) - length(replace(v_definition, v_live_hash_guard_start, ''))
  ) / length(v_live_hash_guard_start);
  v_live_hash_guard_error_count := (
    length(v_definition) - length(replace(v_definition, v_live_hash_guard_error, ''))
  ) / length(v_live_hash_guard_error);

  -- A migration replay is safe only when the complete desired postcondition is
  -- already present. Any partial or unexpected definition remains fail-closed.
  if v_predicate_count = 0
    and v_declaration_count = 0
    and v_live_hash_guard_start_count = 0
    and v_live_hash_guard_error_count = 0
  then
    return;
  end if;

  if v_predicate_count <> 3
    or v_declaration_count <> 1
    or v_live_hash_guard_start_count <> 1
    or v_live_hash_guard_error_count <> 1
  then
    raise exception
      'Unexpected live dependency-hash structure in workforce_payout_payment_candidates (predicates %, declarations %, guard starts %, guard errors %).',
      v_predicate_count,
      v_declaration_count,
      v_live_hash_guard_start_count,
      v_live_hash_guard_error_count;
  end if;

  v_live_hash_guard_start_position := position(v_live_hash_guard_start in v_definition);
  v_live_hash_guard_end_offset := position(
    'end if;' in substring(v_definition from v_live_hash_guard_start_position)
  );
  if v_live_hash_guard_start_position < 1 or v_live_hash_guard_end_offset < 1 then
    raise exception 'The live dependency-hash guard boundaries are unavailable.';
  end if;

  v_definition := overlay(
    v_definition placing ''
    from v_live_hash_guard_start_position
    for v_live_hash_guard_end_offset + length('end if;') - 1
  );
  v_definition := replace(v_definition, v_predicate, '');
  v_definition := replace(v_definition, v_declaration, '');
  execute v_definition;

  select pg_get_functiondef(
    'public.workforce_payout_payment_candidates(uuid,date,date,uuid[])'::regprocedure
  ) into v_definition;
  if position(v_predicate in v_definition) > 0
    or position('v_current_dependency_hash' in v_definition) > 0
    or position('workforce_advance_recovery_snapshot_hash' in v_definition) > 0
  then
    raise exception 'The Workforce bank candidate still depends on the live dependency hash.';
  end if;
end
$patch$;

comment on function public.workforce_payout_payment_candidates(uuid, date, date, uuid[]) is
  'Calculates bank-payment candidates from the latest immutable worksheet publication. Unfinished publication refreshes and mapping relocks block payment; unrelated live dependency-version changes do not rewrite the published financial target.';

notify pgrst, 'reload schema';

commit;
