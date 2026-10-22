begin;

-- The partial finalizer may replay one successful chunk while rejecting a
-- different row from the same uploaded file. A file-level replay flag cannot
-- distinguish those outcomes. Return the physical row numbers that came from
-- replayed successful chunks so callers can report them as already finalized
-- instead of newly reconciled.
do $patch_central_bank_partial_replay_rows$
declare
  v_signature regprocedure;
  v_definition text;
  v_marker constant text :=
    '-- Record successful replayed rows separately from newly finalized rows.';

  v_chunk_declaration constant text := replace($old$
  v_chunk_processed_rows integer;
  v_chunk_row_errors jsonb := '[]'::jsonb;
$old$, E'\r\n', E'\n');
  v_chunk_declaration_replacement constant text := replace($new$
  v_chunk_processed_rows integer;
  v_chunk_row_errors jsonb := '[]'::jsonb;
  v_chunk_replayed_row_numbers jsonb := '[]'::jsonb;
$new$, E'\r\n', E'\n');

  v_replay_declaration constant text := replace($old$
  v_processed_rows integer := 0;
  v_replayed_calls integer := 0;
  v_paid integer := 0;
$old$, E'\r\n', E'\n');
  v_replay_declaration_replacement constant text := replace($new$
  v_processed_rows integer := 0;
  v_replayed_calls integer := 0;
  v_replayed_row_numbers jsonb := '[]'::jsonb;
  v_paid integer := 0;
$new$, E'\r\n', E'\n');

  v_replay_block constant text := replace($old$
    if lower(coalesce(v_inner_result ->> 'replayed', 'false')) = 'true' then
      v_replayed_calls := v_replayed_calls + v_chunk_processed_rows;
    end if;
    v_rows := v_rows || v_inner_rows;
$old$, E'\r\n', E'\n');
  v_replay_block_replacement constant text := replace($new$
    if lower(coalesce(v_inner_result ->> 'replayed', 'false')) = 'true' then
      v_replayed_calls := v_replayed_calls + v_chunk_processed_rows;

      -- Record successful replayed rows separately from newly finalized rows.
      select coalesce(
        jsonb_agg((result.value ->> 'row_number')::integer order by result.ordinality),
        '[]'::jsonb
      )
      into v_chunk_replayed_row_numbers
      from jsonb_array_elements(v_inner_rows) with ordinality result(value, ordinality)
      where lower(coalesce(result.value ->> 'outcome', '')) not in ('rejected', 'unknown')
        and coalesce(result.value ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$';

      if jsonb_array_length(v_chunk_replayed_row_numbers) <> v_chunk_processed_rows then
        raise exception 'The central bank finalizer returned an invalid replayed row result.';
      end if;
      v_replayed_row_numbers := v_replayed_row_numbers || v_chunk_replayed_row_numbers;
    end if;
    v_rows := v_rows || v_inner_rows;
$new$, E'\r\n', E'\n');

  v_return_block constant text := replace($old$
    'processed_rows', v_processed_rows,
    'error_rows', jsonb_array_length(v_row_errors),
$old$, E'\r\n', E'\n');
  v_return_block_replacement constant text := replace($new$
    'processed_rows', v_processed_rows,
    'replayed_row_numbers', v_replayed_row_numbers,
    'error_rows', jsonb_array_length(v_row_errors),
$new$, E'\r\n', E'\n');
begin
  v_signature :=
    'public.finalize_central_bank_response_partially(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_definition := replace(v_definition, E'\r\n', E'\n');

  if position(v_marker in v_definition) = 0 then
    if (length(v_definition) - length(replace(v_definition, v_chunk_declaration, '')))
        / length(v_chunk_declaration) <> 1
      or (length(v_definition) - length(replace(v_definition, v_replay_declaration, '')))
        / length(v_replay_declaration) <> 1
      or (length(v_definition) - length(replace(v_definition, v_replay_block, '')))
        / length(v_replay_block) <> 1
      or (length(v_definition) - length(replace(v_definition, v_return_block, '')))
        / length(v_return_block) <> 1
    then
      raise exception
        'Unexpected partial central bank finalizer replay structure; migration stopped without changing it.';
    end if;

    v_definition := replace(
      v_definition,
      v_chunk_declaration,
      v_chunk_declaration_replacement
    );
    v_definition := replace(
      v_definition,
      v_replay_declaration,
      v_replay_declaration_replacement
    );
    v_definition := replace(v_definition, v_replay_block, v_replay_block_replacement);
    v_definition := replace(v_definition, v_return_block, v_return_block_replacement);
    execute v_definition;
  end if;
end
$patch_central_bank_partial_replay_rows$;

comment on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) is
  'Finalizes valid company-owned rows from one central bank response while returning safe row-level errors and the physical row numbers of successful replayed chunks.';

revoke all on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
