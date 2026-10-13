begin;

-- Federal Bank has returned the bare DropX ID in Customer Ref. No. for some
-- Transaction Enquiry exports. Resolve those rows only from immutable payment
-- instructions. A mutable profile lookup is intentionally insufficient: the
-- exact processing instruction and amount must still be uniquely identified.
create or replace function public.resolve_owned_payout_legacy_response_references(
  p_company_id uuid,
  p_rows jsonb
)
returns table (
  row_number integer,
  resolution_state text,
  reference_no text,
  audience text,
  message text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input record;
  v_dropx_id text;
  v_credit_account text;
  v_ifsc text;
  v_status text;
  v_utr text;
  v_owned_count bigint;
  v_candidates jsonb;
  v_candidate_count integer;
  v_best_score integer;
  v_best_count integer;
begin
  if p_company_id is null then
    raise exception 'Company is required to resolve legacy bank references.';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Legacy bank reference rows must be a JSON array.';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) > 5000 then
    raise exception 'At most 5000 legacy bank reference rows can be resolved at once.';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_rows) as candidate(row_number integer)
    group by candidate.row_number
    having candidate.row_number is null or candidate.row_number <= 0 or count(*) > 1
  ) then
    raise exception 'Legacy bank reference row numbers must be positive and unique.';
  end if;

  for v_input in
    select
      candidate.row_number,
      candidate.dropx_id,
      candidate.debit_amount_paise,
      candidate.credit_account,
      candidate.ifsc,
      candidate.status,
      candidate.utr_cin,
      candidate.amount_error
    from pg_catalog.jsonb_to_recordset(p_rows) as candidate(
      row_number integer,
      dropx_id text,
      debit_amount_paise bigint,
      credit_account text,
      ifsc text,
      status text,
      utr_cin text,
      amount_error text
    )
    order by candidate.row_number
  loop
    row_number := v_input.row_number;
    resolution_state := null;
    reference_no := null;
    audience := null;
    message := null;
    v_dropx_id := public.payout_bank_reference_dropx_canonical(v_input.dropx_id);
    v_credit_account := public.workforce_payout_bank_account_canonical(v_input.credit_account);
    v_ifsc := public.workforce_payout_bank_ifsc_canonical(v_input.ifsc);
    v_status := pg_catalog.upper(pg_catalog.btrim(coalesce(v_input.status, '')));
    if v_status = 'CANCELED' then v_status := 'CANCELLED'; end if;
    v_utr := pg_catalog.regexp_replace(
      pg_catalog.upper(pg_catalog.btrim(coalesce(v_input.utr_cin, ''))),
      '[^A-Z0-9]', '', 'g'
    );

    -- A row with no immutable ledger identity belongs to some other bank
    -- workflow and remains skippable. Once the ID is known to either payout
    -- ledger, failure to identify one processing instruction is actionable.
    select count(*)
    into v_owned_count
    from (
      select item.id
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
      union all
      select item.id
      from public.helper_payout_payment_items item
      where item.company_id = p_company_id
        and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
    ) owned;

    if v_owned_count = 0 then
      resolution_state := 'unrelated';
      return next;
      continue;
    end if;

    if v_input.debit_amount_paise is null or v_input.debit_amount_paise <= 0 then
      resolution_state := 'error';
      message := pg_catalog.format(
        'Row %s: bare DropX ID “%s” belongs to this company, but its Debit Amount is invalid (%s). Nothing was finalized.',
        v_input.row_number,
        v_dropx_id,
        coalesce(nullif(pg_catalog.btrim(v_input.amount_error), ''), 'enter a positive amount with at most two decimal places')
      );
      return next;
      continue;
    end if;

    -- Same-file or equivalent re-uploads arrive after the original item is
    -- already paid. An exact normalized UTR + DropX ID + amount identifies
    -- that immutable terminal instruction more strongly than a new processing
    -- item that happens to have the same ID and amount.
    if v_status = 'PAID' and v_utr not in (
      '', '0', 'NA', 'NIL', 'NONE', 'NULL', 'NOTAVAILABLE', 'NOTAPPLICABLE'
    ) then
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'audience', candidate.audience,
            'reference_no', candidate.reference_no
          ) order by candidate.audience, candidate.reference_no
        ),
        '[]'::jsonb
      )
      into v_candidates
      from (
        select 'workforce'::text as audience, item.reference_no
        from public.workforce_payout_payment_items item
        where item.company_id = p_company_id
          and item.status = 'paid'
          and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
          and pg_catalog.round(item.instruction_amount * 100, 0)::bigint = v_input.debit_amount_paise
          and pg_catalog.regexp_replace(
            pg_catalog.upper(pg_catalog.btrim(coalesce(item.utr_cin, ''))),
            '[^A-Z0-9]', '', 'g'
          ) = v_utr
        union all
        select 'helpers'::text as audience, item.reference_no
        from public.helper_payout_payment_items item
        where item.company_id = p_company_id
          and item.status = 'paid'
          and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
          and pg_catalog.round(item.instruction_amount * 100, 0)::bigint = v_input.debit_amount_paise
          and pg_catalog.regexp_replace(
            pg_catalog.upper(pg_catalog.btrim(coalesce(item.utr_cin, ''))),
            '[^A-Z0-9]', '', 'g'
          ) = v_utr
      ) candidate;

      v_candidate_count := pg_catalog.jsonb_array_length(v_candidates);
      if v_candidate_count = 1 then
        reference_no := v_candidates -> 0 ->> 'reference_no';
        audience := v_candidates -> 0 ->> 'audience';
        resolution_state := 'resolved';
        return next;
        continue;
      elsif v_candidate_count > 1 then
        resolution_state := 'error';
        message := pg_catalog.format(
          'Row %s: bare DropX ID “%s”, amount %s and UTR/CIN “%s” match %s paid instructions. Historical payment evidence is ambiguous, so nothing was finalized.',
          v_input.row_number,
          v_dropx_id,
          pg_catalog.to_char(v_input.debit_amount_paise::numeric / 100, 'FM999999999999990.00'),
          v_utr,
          v_candidate_count
        );
        return next;
        continue;
      end if;
    end if;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'audience', candidate.audience,
          'reference_no', candidate.reference_no,
          'evidence_score', candidate.evidence_score
        ) order by candidate.audience, candidate.reference_no
      ),
      '[]'::jsonb
    )
    into v_candidates
    from (
      select
        'workforce'::text as audience,
        item.reference_no,
        (case
          when v_credit_account <> ''
            and public.workforce_payout_bank_account_canonical(item.bank_account_no_snapshot) = v_credit_account
          then 2 else 0 end)
        + (case
          when v_ifsc <> ''
            and public.workforce_payout_bank_ifsc_canonical(item.ifsc_snapshot) = v_ifsc
          then 1 else 0 end) as evidence_score
      from public.workforce_payout_payment_items item
      where item.company_id = p_company_id
        and item.status = 'processing'
        and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
        and pg_catalog.round(item.instruction_amount * 100, 0)::bigint = v_input.debit_amount_paise
      union all
      select
        'helpers'::text as audience,
        item.reference_no,
        (case
          when v_credit_account <> ''
            and public.workforce_payout_bank_account_canonical(item.bank_account_no_snapshot) = v_credit_account
          then 2 else 0 end)
        + (case
          when v_ifsc <> ''
            and public.workforce_payout_bank_ifsc_canonical(item.ifsc_snapshot) = v_ifsc
          then 1 else 0 end) as evidence_score
      from public.helper_payout_payment_items item
      where item.company_id = p_company_id
        and item.status = 'processing'
        and public.payout_bank_reference_dropx_canonical(item.dropx_id_snapshot) = v_dropx_id
        and pg_catalog.round(item.instruction_amount * 100, 0)::bigint = v_input.debit_amount_paise
    ) candidate;

    v_candidate_count := pg_catalog.jsonb_array_length(v_candidates);
    if v_candidate_count = 0 then
      resolution_state := 'error';
      message := pg_catalog.format(
        'Row %s: bare DropX ID “%s” belongs to this company, but no Payment Processing instruction has the exact bank amount %s. Re-download or verify the response file; nothing was finalized.',
        v_input.row_number,
        v_dropx_id,
        pg_catalog.to_char(v_input.debit_amount_paise::numeric / 100, 'FM999999999999990.00')
      );
      return next;
      continue;
    end if;

    if v_candidate_count = 1 then
      reference_no := v_candidates -> 0 ->> 'reference_no';
      audience := v_candidates -> 0 ->> 'audience';
      resolution_state := 'resolved';
      return next;
      continue;
    end if;

    select max((entry.value ->> 'evidence_score')::integer)
    into v_best_score
    from pg_catalog.jsonb_array_elements(v_candidates) entry(value);
    select
      count(*),
      max(entry.value ->> 'reference_no'),
      max(entry.value ->> 'audience')
    into v_best_count, reference_no, audience
    from pg_catalog.jsonb_array_elements(v_candidates) entry(value)
    where (entry.value ->> 'evidence_score')::integer = v_best_score;

    if v_best_score > 0 and v_best_count = 1 then
      resolution_state := 'resolved';
      return next;
      continue;
    end if;

    reference_no := null;
    audience := null;
    resolution_state := 'error';
    message := pg_catalog.format(
      'Row %s: bare DropX ID “%s” and amount %s match %s Payment Processing instructions. Use a bank response with the generated WF/HP reference, or ensure the actual paid account/IFSC uniquely identifies one instruction. Nothing was finalized.',
      v_input.row_number,
      v_dropx_id,
      pg_catalog.to_char(v_input.debit_amount_paise::numeric / 100, 'FM999999999999990.00'),
      v_candidate_count
    );
    return next;
  end loop;
end
$function$;

comment on function public.resolve_owned_payout_legacy_response_references(uuid,jsonb) is
  'Safely maps Federal Bank rows containing a bare DropX ID to one immutable processing instruction by company, normalized DropX ID and exact amount; bank account and IFSC are disambiguators only.';

revoke all on function public.resolve_owned_payout_legacy_response_references(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_owned_payout_legacy_response_references(uuid,jsonb)
  to service_role;

notify pgrst, 'reload schema';

commit;
