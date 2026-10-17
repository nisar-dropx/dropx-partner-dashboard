begin;

-- Bind the caller-visible operation ID to the complete scoped file payload.
-- Child finalizer calls use deterministic derived IDs, so this separate exact
-- binding preserves the central finalizer's operation-id replay contract.
create table if not exists public.central_bank_response_partial_operations (
  company_id uuid not null references public.companies(id) on delete restrict,
  operation_id uuid not null,
  file_sha256 text not null,
  normalized_payload_hash text not null,
  normalized_payload jsonb not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (company_id, operation_id),
  constraint central_bank_response_partial_operations_file_hash_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint central_bank_response_partial_operations_payload_hash_check
    check (normalized_payload_hash ~ '^[0-9a-f]{32}$'),
  constraint central_bank_response_partial_operations_payload_check
    check (jsonb_typeof(normalized_payload) = 'object')
);

alter table public.central_bank_response_partial_operations enable row level security;
alter table public.central_bank_response_partial_operations force row level security;
revoke all on table public.central_bank_response_partial_operations
  from public, anon, authenticated, service_role;
grant select on table public.central_bank_response_partial_operations to service_role;
drop policy if exists central_bank_response_partial_operations_service_select
  on public.central_bank_response_partial_operations;
create policy central_bank_response_partial_operations_service_select
  on public.central_bank_response_partial_operations for select to service_role using (true);

-- Process non-conflicting rows as large atomic chunks. If a known row-level
-- validation fails, bisect only that chunk until the bad row is isolated. The
-- existing finalizer remains the sole mutation path and retains its company,
-- ownership, immutable-instruction, replay and cross-ledger UTR checks.
create or replace function public.finalize_central_bank_response_partially(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_operation_id uuid,
  p_file_sha256 text,
  p_file_name text,
  p_workforce_rows jsonb,
  p_helper_rows jsonb,
  p_payment_request_rows jsonb,
  p_payroll_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_total_count integer;
  v_full_payload jsonb;
  v_full_payload_hash text;
  v_operation_binding public.central_bank_response_partial_operations%rowtype;
  v_input_rows jsonb;
  v_item jsonb;
  v_row jsonb;
  v_ledger text;
  v_position integer;
  v_row_number integer;
  v_reference text;
  v_duplicate_references text[] := '{}'::text[];
  v_duplicate_utrs text[] := '{}'::text[];

  v_inner_result jsonb;
  v_inner_rows jsonb;
  v_inner_row jsonb;
  v_inner_operation_id uuid;
  v_error_state text;
  v_error_message text;
  v_safe_error_message text;
  v_pending_rows jsonb := '[]'::jsonb;
  v_chunk_queue jsonb := '[]'::jsonb;
  v_chunk jsonb;
  v_left_chunk jsonb;
  v_right_chunk jsonb;
  v_chunk_workforce_rows jsonb;
  v_chunk_helper_rows jsonb;
  v_chunk_payment_request_rows jsonb;
  v_chunk_payroll_rows jsonb;
  v_chunk_size integer;
  v_chunk_processed_rows integer;
  v_chunk_row_errors jsonb := '[]'::jsonb;
  v_split_at integer;

  v_rows jsonb := '[]'::jsonb;
  v_row_errors jsonb := '[]'::jsonb;
  v_payment_events jsonb := '[]'::jsonb;
  v_batch_ids jsonb := '[]'::jsonb;
  v_payroll_run_ids jsonb := '[]'::jsonb;
  v_central_import_ids jsonb := '[]'::jsonb;
  v_ledgers jsonb := '{}'::jsonb;

  v_processed_rows integer := 0;
  v_replayed_calls integer := 0;
  v_paid integer := 0;
  v_cancelled integer := 0;
  v_failed integer := 0;
  v_replayed_items integer := 0;
  v_rejected integer := 0;
  v_unknown integer := 0;
begin
  if p_company_id is null or p_actor_user_id is null or p_operation_id is null then
    raise exception 'Company, actor and operation are required for a central bank response.';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 bank response file hash is required.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null or length(p_file_name) > 240 then
    raise exception 'A valid bank response file name is required.';
  end if;
  if jsonb_typeof(p_workforce_rows) is distinct from 'array'
    or jsonb_typeof(p_helper_rows) is distinct from 'array'
    or jsonb_typeof(p_payment_request_rows) is distinct from 'array'
    or jsonb_typeof(p_payroll_rows) is distinct from 'array'
  then
    raise exception 'Every central bank response ledger payload must be an array.';
  end if;

  v_total_count := jsonb_array_length(p_workforce_rows)
    + jsonb_array_length(p_helper_rows)
    + jsonb_array_length(p_payment_request_rows)
    + jsonb_array_length(p_payroll_rows);
  if v_total_count < 1 or v_total_count > 5000 then
    raise exception 'Central bank response must contain between 1 and 5000 company-owned rows.';
  end if;
  if not exists (select 1 from public.companies company where company.id = p_company_id) then
    raise exception 'Company was not found.';
  end if;
  if not exists (select 1 from auth.users actor where actor.id = p_actor_user_id) then
    raise exception 'Payment actor was not found.';
  end if;

  v_full_payload := jsonb_build_object(
    'workforce', p_workforce_rows,
    'helpers', p_helper_rows,
    'payment_requests', p_payment_request_rows,
    'people_payroll', p_payroll_rows
  );
  v_full_payload_hash := md5(v_full_payload::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'central-bank-response-partial:operation:'
      || p_company_id::text || ':' || p_operation_id::text,
    0
  ));
  insert into public.central_bank_response_partial_operations(
    company_id,
    operation_id,
    file_sha256,
    normalized_payload_hash,
    normalized_payload,
    created_by
  ) values (
    p_company_id,
    p_operation_id,
    p_file_sha256,
    v_full_payload_hash,
    v_full_payload,
    p_actor_user_id
  )
  on conflict (company_id, operation_id) do nothing;

  select binding.* into v_operation_binding
  from public.central_bank_response_partial_operations binding
  where binding.company_id = p_company_id
    and binding.operation_id = p_operation_id;
  if not found then
    raise exception 'The central bank response operation binding could not be verified.';
  end if;
  if v_operation_binding.file_sha256 <> p_file_sha256
    or v_operation_binding.normalized_payload_hash <> v_full_payload_hash
    or v_operation_binding.normalized_payload is distinct from v_full_payload
  then
    raise exception 'This central bank response operation ID was already used for a different file or complete payload.';
  end if;

  -- Keep worksheet order across all ledgers.  That makes the response stable
  -- without making financial correctness depend on first-row-wins behaviour.
  select coalesce(jsonb_agg(input.item order by input.row_number, input.ledger_order, input.position), '[]'::jsonb)
  into v_input_rows
  from (
    select
      jsonb_build_object(
        'ledger', source.ledger,
        'ledger_order', source.ledger_order,
        'position', response.ordinality,
        'row', response.value
      ) item,
      case
        when coalesce(response.value ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$'
          then (response.value ->> 'row_number')::integer
        else 1000000000
      end row_number,
      source.ledger_order,
      response.ordinality position
    from (
      values
        ('workforce'::text, 0, p_workforce_rows),
        ('helpers'::text, 1, p_helper_rows),
        ('payment_requests'::text, 2, p_payment_request_rows),
        ('people_payroll'::text, 3, p_payroll_rows)
    ) source(ledger, ledger_order, rows)
    cross join lateral jsonb_array_elements(source.rows)
      with ordinality response(value, ordinality)
  ) input;

  -- A duplicated normalized reference is inherently ambiguous.  Reject every
  -- occurrence instead of finalizing whichever copy happened to come first.
  select coalesce(array_agg(duplicate.reference_no order by duplicate.reference_no), '{}'::text[])
  into v_duplicate_references
  from (
    select public.workforce_payout_bank_reference_canonical(input.value -> 'row' ->> 'reference_no') reference_no
    from jsonb_array_elements(v_input_rows) input(value)
    where public.workforce_payout_bank_reference_canonical(input.value -> 'row' ->> 'reference_no') <> ''
    group by public.workforce_payout_bank_reference_canonical(input.value -> 'row' ->> 'reference_no')
    having count(*) > 1
  ) duplicate;

  -- Likewise, if one paid UTR is attached to different references in this
  -- upload, reject the whole conflict group.  No payment wins by row order.
  select coalesce(array_agg(duplicate.normalized_utr order by duplicate.normalized_utr), '{}'::text[])
  into v_duplicate_utrs
  from (
    select regexp_replace(
      upper(btrim(coalesce(input.value -> 'row' ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
    ) normalized_utr
    from jsonb_array_elements(v_input_rows) input(value)
    where upper(btrim(coalesce(input.value -> 'row' ->> 'status', ''))) = 'PAID'
      and regexp_replace(
        upper(btrim(coalesce(input.value -> 'row' ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
      ) not in ('', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE')
    group by regexp_replace(
      upper(btrim(coalesce(input.value -> 'row' ->> 'utr_cin', ''))), '[^A-Z0-9]', '', 'g'
    )
    having count(distinct public.workforce_payout_bank_reference_canonical(
      input.value -> 'row' ->> 'reference_no'
    )) > 1
  ) duplicate;

  -- Classify conflict groups and every currently observable whitelisted DB
  -- validation in one set operation. This avoids O(n^2) JSONB concatenation
  -- and prevents a file containing many debit/date/owner/UTR errors from
  -- forcing a 2n-1 finalizer-call isolation tree. The central finalizer still
  -- repeats all checks under its mutation locks; bisection below is retained
  -- only for races that arise after this prevalidation snapshot.
  with normalized as materialized (
    select
      input.value item,
      input.ordinality,
      btrim(coalesce(input.value ->> 'ledger', '')) ledger,
      input.value -> 'row' row_value,
      case
        when coalesce(input.value ->> 'position', '') ~ '^[1-9][0-9]{0,8}$'
          then (input.value ->> 'position')::integer
        else 1
      end position,
      public.workforce_payout_bank_reference_canonical(
        input.value -> 'row' ->> 'reference_no'
      ) reference_no,
      upper(btrim(coalesce(input.value -> 'row' ->> 'status', ''))) response_status,
      regexp_replace(
        upper(btrim(coalesce(input.value -> 'row' ->> 'utr_cin', ''))),
        '[^A-Z0-9]', '', 'g'
      ) normalized_utr,
      public.workforce_payout_bank_account_canonical(
        input.value -> 'row' ->> 'debit_account'
      ) debit_account,
      btrim(coalesce(input.value -> 'row' ->> 'value_date', '')) value_date_text
    from jsonb_array_elements(v_input_rows) with ordinality input(value, ordinality)
  ), input_meaningful_utrs as materialized (
    select distinct candidate.normalized_utr
    from normalized candidate
    where candidate.response_status = 'PAID'
      and candidate.normalized_utr not in (
        '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
      )
  ), existing_utr_claims as materialized (
    select input_utr.normalized_utr,
      public.workforce_payout_bank_reference_canonical(paid.reference_no) reference_no
    from input_meaningful_utrs input_utr
    join public.payout_bank_paid_transaction_registry paid
      on paid.company_id = p_company_id
      and paid.normalized_utr = input_utr.normalized_utr
    union all
    select input_utr.normalized_utr,
      public.workforce_payout_bank_reference_canonical(claim.reference_no)
    from input_meaningful_utrs input_utr
    join public.central_bank_paid_transaction_registry claim
      on claim.company_id = p_company_id
      and claim.normalized_utr = input_utr.normalized_utr
    union all
    select input_utr.normalized_utr,
      public.workforce_payout_bank_reference_canonical(request.request_no)
    from public.payment_requests request
    join input_meaningful_utrs input_utr
      on input_utr.normalized_utr = regexp_replace(
        upper(btrim(coalesce(request.utr_cin, ''))), '[^A-Z0-9]', '', 'g'
      )
    where request.company_id = p_company_id
      and (lower(coalesce(request.status, '')) = 'processed'
        or upper(coalesce(request.approval_status, '')) = 'PROCESSED')
    union all
    select input_utr.normalized_utr,
      public.workforce_payout_bank_reference_canonical(line.reference)
    from public.hr_payroll_bank_lines line
    join input_meaningful_utrs input_utr
      on input_utr.normalized_utr = regexp_replace(
        upper(btrim(coalesce(line.utr, ''))), '[^A-Z0-9]', '', 'g'
      )
    where line.company_id = p_company_id and line.status = 'paid'
  ), evidence as (
    select
      candidate.*,
      workforce.id workforce_id,
      workforce.status workforce_status,
      workforce.utr_cin workforce_utr,
      workforce_batch.debit_account_no_snapshot expected_workforce_debit,
      workforce_batch.value_date expected_workforce_date,
      helper.id helper_id,
      helper.status helper_status,
      helper.utr_cin helper_utr,
      helper_batch.debit_account_no_snapshot expected_helper_debit,
      helper_batch.value_date expected_helper_date,
      payment_request.id payment_request_id,
      payment_request.status payment_request_status,
      payment_request.approval_status payment_request_approval_status,
      payment_request.utr_cin payment_request_utr,
      payroll.id payroll_id,
      payroll.status payroll_status,
      payroll.utr payroll_utr
    from normalized candidate
    left join public.workforce_payout_payment_items workforce
      on workforce.company_id = p_company_id
      and workforce.reference_no = candidate.reference_no
    left join public.workforce_payout_payment_batches workforce_batch
      on workforce_batch.id = workforce.batch_id
    left join public.helper_payout_payment_items helper
      on helper.company_id = p_company_id
      and helper.reference_no = candidate.reference_no
    left join public.helper_payout_payment_batches helper_batch
      on helper_batch.id = helper.batch_id
    left join public.payment_requests payment_request
      on payment_request.company_id = p_company_id
      and payment_request.request_no = candidate.reference_no
    left join public.hr_payroll_bank_lines payroll
      on payroll.company_id = p_company_id
      and payroll.reference = candidate.reference_no
  ), classified as (
    select evidence.*,
      case
        -- Structural parser/programmer failures are deliberately left for the
        -- existing finalizer so an unknown exception remains request-fatal.
        when jsonb_typeof(evidence.row_value) is distinct from 'object'
          or evidence.reference_no = '' or length(evidence.reference_no) > 128
          then null
        when evidence.reference_no = any(v_duplicate_references)
          then 'Duplicate Customer Ref. No. ' || evidence.reference_no
            || ' appears more than once in this file.'
        when evidence.response_status = 'PAID'
          and evidence.normalized_utr = any(v_duplicate_utrs)
          then 'The same UTR/CIN is attached to more than one payment in this file.'
        when (
          (evidence.workforce_id is not null)::integer
          + (evidence.helper_id is not null)::integer
          + (evidence.payment_request_id is not null)::integer
          + (evidence.payroll_id is not null)::integer
        ) <> 1
          or not case evidence.ledger
            when 'workforce' then evidence.workforce_id is not null
            when 'helpers' then evidence.helper_id is not null
            when 'payment_requests' then evidence.payment_request_id is not null
            when 'people_payroll' then evidence.payroll_id is not null
            else false
          end
          then 'This reference no longer matches one exact company payment instruction.'
        when evidence.ledger = 'workforce'
          and evidence.debit_account <> ''
          and evidence.debit_account <> public.workforce_payout_bank_account_canonical(
            evidence.expected_workforce_debit
          )
          then 'Debit account does not match the generated bank instruction.'
        when evidence.ledger = 'helpers'
          and evidence.debit_account <> ''
          and evidence.debit_account <> public.workforce_payout_bank_account_canonical(
            evidence.expected_helper_debit
          )
          then 'Debit account does not match the generated bank instruction.'
        when evidence.ledger = 'workforce'
          and evidence.value_date_text <> ''
          and evidence.value_date_text <> coalesce(
            to_char(evidence.expected_workforce_date, 'YYYY-MM-DD'), ''
          )
          then 'Value date does not match the generated bank instruction.'
        when evidence.ledger = 'helpers'
          and evidence.value_date_text <> ''
          and evidence.value_date_text <> coalesce(
            to_char(evidence.expected_helper_date, 'YYYY-MM-DD'), ''
          )
          then 'Value date does not match the generated bank instruction.'
        when evidence.response_status = 'PAID'
          and evidence.normalized_utr not in (
            '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
          )
          and exists (
            select 1
            from existing_utr_claims claim
            where claim.normalized_utr = evidence.normalized_utr
              and claim.reference_no <> evidence.reference_no
          )
          then 'This UTR/CIN is already recorded for another paid instruction.'
        when evidence.response_status = 'PAID'
          and evidence.normalized_utr not in (
            '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
          )
          and case evidence.ledger
            when 'workforce' then lower(coalesce(evidence.workforce_status, '')) = 'paid'
              and regexp_replace(
                upper(btrim(coalesce(evidence.workforce_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> ''
              and regexp_replace(
                upper(btrim(coalesce(evidence.workforce_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> evidence.normalized_utr
            when 'helpers' then lower(coalesce(evidence.helper_status, '')) = 'paid'
              and regexp_replace(
                upper(btrim(coalesce(evidence.helper_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> ''
              and regexp_replace(
                upper(btrim(coalesce(evidence.helper_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> evidence.normalized_utr
            when 'payment_requests' then (
              lower(coalesce(evidence.payment_request_status, '')) = 'processed'
              or upper(coalesce(evidence.payment_request_approval_status, '')) = 'PROCESSED'
            ) and regexp_replace(
              upper(btrim(coalesce(evidence.payment_request_utr, ''))), '[^A-Z0-9]', '', 'g'
            ) <> ''
              and regexp_replace(
                upper(btrim(coalesce(evidence.payment_request_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> evidence.normalized_utr
            when 'people_payroll' then evidence.payroll_status = 'paid'
              and regexp_replace(
                upper(btrim(coalesce(evidence.payroll_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> ''
              and regexp_replace(
                upper(btrim(coalesce(evidence.payroll_utr, ''))), '[^A-Z0-9]', '', 'g'
              ) <> evidence.normalized_utr
            else false
          end
          then 'A recorded bank UTR/CIN cannot be replaced after payment.'
        else null
      end validation_message
    from evidence
  ), rendered as (
    select classified.*,
      case when classified.validation_message is not null then jsonb_build_object(
        'ledger', classified.ledger,
        'row_number', case
          when coalesce(classified.row_value ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$'
            then (classified.row_value ->> 'row_number')::integer
          else classified.position
        end,
        'reference_no', classified.reference_no,
        'outcome', 'rejected',
        'message', classified.validation_message
      ) end error_row
    from classified
  )
  select
    coalesce(jsonb_agg(rendered.item order by rendered.ordinality)
      filter (where rendered.validation_message is null), '[]'::jsonb),
    coalesce(jsonb_agg(rendered.error_row order by rendered.ordinality)
      filter (where rendered.validation_message is not null), '[]'::jsonb),
    coalesce(jsonb_agg(rendered.error_row - 'outcome' order by rendered.ordinality)
      filter (where rendered.validation_message is not null), '[]'::jsonb)
  into v_pending_rows, v_rows, v_row_errors
  from rendered;

  if jsonb_array_length(v_pending_rows) > 0 then
    v_chunk_queue := jsonb_build_array(v_pending_rows);
  end if;

  -- Try the largest remaining chunk. A whitelisted row validation error rolls
  -- back that call's subtransaction, then splits the chunk in half. With one
  -- bad row, a 5,000-row file therefore needs logarithmic isolation calls plus
  -- the successful sibling chunks, rather than 5,000 singleton calls.
  <<chunk_loop>>
  while jsonb_array_length(v_chunk_queue) > 0 loop
    v_chunk := v_chunk_queue -> 0;
    v_chunk_queue := v_chunk_queue - 0;
    v_chunk_size := jsonb_array_length(v_chunk);

    select
      coalesce(jsonb_agg(chunk_item.value -> 'row' order by chunk_item.ordinality)
        filter (where chunk_item.value ->> 'ledger' = 'workforce'), '[]'::jsonb),
      coalesce(jsonb_agg(chunk_item.value -> 'row' order by chunk_item.ordinality)
        filter (where chunk_item.value ->> 'ledger' = 'helpers'), '[]'::jsonb),
      coalesce(jsonb_agg(chunk_item.value -> 'row' order by chunk_item.ordinality)
        filter (where chunk_item.value ->> 'ledger' = 'payment_requests'), '[]'::jsonb),
      coalesce(jsonb_agg(chunk_item.value -> 'row' order by chunk_item.ordinality)
        filter (where chunk_item.value ->> 'ledger' = 'people_payroll'), '[]'::jsonb)
    into
      v_chunk_workforce_rows,
      v_chunk_helper_rows,
      v_chunk_payment_request_rows,
      v_chunk_payroll_rows
    from jsonb_array_elements(v_chunk) with ordinality chunk_item(value, ordinality);

    -- The exact chunk contents define a deterministic child operation ID. The
    -- existing file hash + normalized chunk payload remains the replay key.
    v_inner_operation_id := md5(
      p_operation_id::text || ':chunk:' || md5(v_chunk::text)
    )::uuid;
    v_inner_result := null;
    v_error_state := null;
    v_error_message := null;
    v_safe_error_message := null;

    begin
      v_inner_result := public.finalize_central_bank_response(
        p_company_id,
        p_actor_user_id,
        v_inner_operation_id,
        p_file_sha256,
        p_file_name,
        v_chunk_workforce_rows,
        v_chunk_helper_rows,
        v_chunk_payment_request_rows,
        v_chunk_payroll_rows
      );
    exception when others then
      get stacked diagnostics
        v_error_state = returned_sqlstate,
        v_error_message = message_text;

      -- Only known row-scoped financial validations may be isolated. Raw SQL
      -- messages, unknown explicit exceptions, constraints and programmer or
      -- infrastructure failures abort the request and remain observable.
      if v_error_state = 'P0001' then
        if v_error_message like 'Debit account does not match the generated instruction for reference %.' then
          v_safe_error_message := 'Debit account does not match the generated bank instruction.';
        elsif v_error_message like 'Value date does not match the generated instruction for reference %.' then
          v_safe_error_message := 'Value date does not match the generated bank instruction.';
        elsif v_error_message = 'The same UTR/CIN is attached to more than one payment in this scoped bank response.' then
          v_safe_error_message := 'The same UTR/CIN is attached to more than one payment.';
        elsif v_error_message = 'This UTR/CIN is already recorded for another paid instruction.' then
          v_safe_error_message := 'This UTR/CIN is already recorded for another paid instruction.';
        elsif v_error_message = 'Bank UTR/CIN cannot be replaced after a payment is marked paid.' then
          v_safe_error_message := 'A recorded bank UTR/CIN cannot be replaced after payment.';
        elsif v_error_message like 'Customer reference % is missing, ambiguous, or assigned to the wrong payment ledger for this company.' then
          v_safe_error_message := 'This reference no longer matches one exact company payment instruction.';
        elsif v_error_message = 'Every Workforce response row must reference a payment owned by this company.' then
          v_safe_error_message := 'This Workforce payment is no longer available for finalization.';
        elsif v_error_message = 'Every Helper response row must reference a payment owned by this company.' then
          v_safe_error_message := 'This Helper payment is no longer available for finalization.';
        elsif v_error_message like 'Payment request % no longer belongs to this company.' then
          v_safe_error_message := 'This payment request is no longer available for finalization.';
        elsif v_error_message like 'Payroll payment % no longer belongs to this company.' then
          v_safe_error_message := 'This payroll payment is no longer available for finalization.';
        end if;
      end if;
      if v_safe_error_message is null then
        raise;
      end if;

      if v_chunk_size > 1 then
        v_split_at := (v_chunk_size + 1) / 2;
        select coalesce(jsonb_agg(part.value order by part.ordinality), '[]'::jsonb)
        into v_left_chunk
        from jsonb_array_elements(v_chunk) with ordinality part(value, ordinality)
        where part.ordinality <= v_split_at;
        select coalesce(jsonb_agg(part.value order by part.ordinality), '[]'::jsonb)
        into v_right_chunk
        from jsonb_array_elements(v_chunk) with ordinality part(value, ordinality)
        where part.ordinality > v_split_at;
        v_chunk_queue := jsonb_build_array(v_left_chunk, v_right_chunk) || v_chunk_queue;
        continue chunk_loop;
      end if;

      v_item := v_chunk -> 0;
      v_ledger := btrim(coalesce(v_item ->> 'ledger', ''));
      v_row := v_item -> 'row';
      v_position := case
        when coalesce(v_item ->> 'position', '') ~ '^[1-9][0-9]{0,8}$'
          then (v_item ->> 'position')::integer
        else 1
      end;
      v_row_number := case
        when coalesce(v_row ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$'
          then (v_row ->> 'row_number')::integer
        else v_position
      end;
      v_reference := public.workforce_payout_bank_reference_canonical(v_row ->> 'reference_no');
      v_inner_row := jsonb_build_object(
        'ledger', v_ledger,
        'row_number', v_row_number,
        'reference_no', v_reference,
        'outcome', 'rejected',
        'message', v_safe_error_message
      );
      v_rows := v_rows || jsonb_build_array(v_inner_row);
      v_row_errors := v_row_errors || jsonb_build_array(v_inner_row - 'outcome');
      continue chunk_loop;
    end;

    v_inner_rows := coalesce(v_inner_result -> 'rows', '[]'::jsonb);
    if jsonb_typeof(v_inner_rows) is distinct from 'array' then
      raise exception 'The central bank finalizer returned an invalid row result.';
    end if;
    if jsonb_array_length(v_inner_rows) <> v_chunk_size then
      raise exception 'The central bank finalizer returned an incomplete row result.';
    end if;
    select count(*) filter (
      where lower(coalesce(result.value ->> 'outcome', '')) not in ('rejected', 'unknown')
    )::integer
    into v_chunk_processed_rows
    from jsonb_array_elements(v_inner_rows) result(value);
    v_processed_rows := v_processed_rows + v_chunk_processed_rows;
    if lower(coalesce(v_inner_result ->> 'replayed', 'false')) = 'true' then
      v_replayed_calls := v_replayed_calls + v_chunk_processed_rows;
    end if;
    v_rows := v_rows || v_inner_rows;
    v_payment_events := v_payment_events
      || coalesce(v_inner_result -> 'payment_request_events', '[]'::jsonb);
    v_batch_ids := v_batch_ids || coalesce(v_inner_result -> 'batch_ids', '[]'::jsonb);
    v_payroll_run_ids := v_payroll_run_ids
      || coalesce(v_inner_result -> 'payroll_run_ids', '[]'::jsonb);
    if nullif(btrim(coalesce(v_inner_result ->> 'central_import_id', '')), '') is not null then
      v_central_import_ids := v_central_import_ids
        || jsonb_build_array(v_inner_result ->> 'central_import_id');
    end if;

    -- Rejected/unknown rows returned as data are already safely skipped by the
    -- existing finalizer. Aggregate once per chunk instead of repeatedly
    -- copying a growing JSONB array for a large rejected result set.
    select coalesce(jsonb_agg(jsonb_build_object(
      'ledger', coalesce(nullif(result.value ->> 'ledger', ''), 'unknown'),
      'row_number', case
        when coalesce(result.value ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$'
          then (result.value ->> 'row_number')::integer
        else 1
      end,
      'reference_no', public.workforce_payout_bank_reference_canonical(
        result.value ->> 'reference_no'
      ),
      'message', coalesce(
        nullif(btrim(result.value ->> 'message'), ''),
        'This bank response row could not be finalized safely.'
      )
    ) order by result.ordinality), '[]'::jsonb)
    into v_chunk_row_errors
    from jsonb_array_elements(v_inner_rows) with ordinality result(value, ordinality)
    where lower(coalesce(result.value ->> 'outcome', '')) in ('rejected', 'unknown');
    v_row_errors := v_row_errors || v_chunk_row_errors;
  end loop chunk_loop;

  -- De-duplicate identifier arrays while retaining deterministic output.
  select coalesce(jsonb_agg(identifier.value order by identifier.value), '[]'::jsonb)
  into v_batch_ids
  from (
    select distinct value from jsonb_array_elements_text(v_batch_ids) value
  ) identifier;
  select coalesce(jsonb_agg(identifier.value order by identifier.value), '[]'::jsonb)
  into v_payroll_run_ids
  from (
    select distinct value from jsonb_array_elements_text(v_payroll_run_ids) value
  ) identifier;
  select coalesce(jsonb_agg(identifier.value order by identifier.value), '[]'::jsonb)
  into v_central_import_ids
  from (
    select distinct value from jsonb_array_elements_text(v_central_import_ids) value
  ) identifier;

  select
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'paid'),
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) in ('cancelled', 'failed')),
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'failed'),
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'replayed'),
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'rejected'),
    count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'unknown')
  into v_paid, v_cancelled, v_failed, v_replayed_items, v_rejected, v_unknown
  from jsonb_array_elements(v_rows) result(value);

  -- Preserve the existing per-ledger result shape so current consumers can
  -- continue to read counts while new consumers use row_errors directly.
  select coalesce(jsonb_object_agg(grouped.ledger, jsonb_build_object(
    'paid', grouped.paid,
    'cancelled', grouped.cancelled,
    'failed', grouped.failed,
    'replayed_items', grouped.replayed_items,
    'rejected', grouped.rejected,
    'unknown', grouped.unknown,
    'rows', grouped.rows
  )), '{}'::jsonb)
  into v_ledgers
  from (
    select
      coalesce(nullif(result.value ->> 'ledger', ''), 'unknown') ledger,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'paid') paid,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) in ('cancelled', 'failed')) cancelled,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'failed') failed,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'replayed') replayed_items,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'rejected') rejected,
      count(*) filter (where lower(coalesce(result.value ->> 'outcome', '')) = 'unknown') unknown,
      jsonb_agg(result.value order by
        case when coalesce(result.value ->> 'row_number', '') ~ '^[1-9][0-9]{0,8}$'
          then (result.value ->> 'row_number')::integer else 1000000000 end
      ) rows
    from jsonb_array_elements(v_rows) result(value)
    group by coalesce(nullif(result.value ->> 'ledger', ''), 'unknown')
  ) grouped;

  return jsonb_build_object(
    'replayed', jsonb_array_length(v_row_errors) = 0
      and v_processed_rows = v_total_count
      and v_replayed_calls = v_processed_rows,
    'paid', v_paid,
    'cancelled', v_cancelled,
    'failed', v_failed,
    'replayed_items', v_replayed_items,
    'rejected', v_rejected,
    'unknown', v_unknown,
    'batch_ids', v_batch_ids,
    'payroll_run_ids', v_payroll_run_ids,
    'central_import_ids', v_central_import_ids,
    'payment_request_events', v_payment_events,
    'processed_rows', v_processed_rows,
    'error_rows', jsonb_array_length(v_row_errors),
    'row_errors', v_row_errors,
    'ledgers', v_ledgers,
    'rows', v_rows
  );
end
$function$;

comment on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) is
  'Finalizes authorised mixed bank-response rows in prevalidated chunks, binds the outer operation to the exact file payload, preserves central finalizer checks, and returns row-level errors without rolling back valid rows.';

revoke all on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_central_bank_response_partially(
  uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;
