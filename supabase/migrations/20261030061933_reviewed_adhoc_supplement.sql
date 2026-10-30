-- A reviewed bank-paid supplement can share a work date with its original
-- payment. Match both immutable requests and the exact supplementary bank UTR.
begin;
create table if not exists public.payment_adhoc_supplement_reviews (
  payment_request_id uuid primary key references public.payment_requests(id),
  original_payment_request_id uuid not null references public.payment_requests(id),
  company_id uuid not null references public.companies(id),
  amount numeric(14,2) not null check (amount > 0),
  normalized_utr text not null check (normalized_utr ~ '^[A-Z0-9]{4,80}$'),
  reason text not null check (length(btrim(reason)) >= 20),
  review_source text not null check (length(btrim(review_source)) >= 10),
  reviewed_at timestamptz not null default now(),
  check (payment_request_id <> original_payment_request_id)
);
create index if not exists payment_adhoc_supplement_original_idx on public.payment_adhoc_supplement_reviews(original_payment_request_id);
create index if not exists payment_adhoc_supplement_company_idx on public.payment_adhoc_supplement_reviews(company_id);
alter table public.payment_adhoc_supplement_reviews enable row level security;
revoke all on public.payment_adhoc_supplement_reviews from public,anon,authenticated;
grant select,insert on public.payment_adhoc_supplement_reviews to service_role;

create or replace function public.guard_adhoc_supplement_review() returns trigger
language plpgsql set search_path='' as $guard$
begin
  if tg_op <> 'INSERT' then raise exception 'Supplement reviews are immutable'; end if;
  if not exists (
    select 1 from public.payment_requests supplement join public.payment_requests original
      on original.id=new.original_payment_request_id
    where supplement.id=new.payment_request_id and supplement.company_id=new.company_id and original.company_id=new.company_id
      and supplement.source_system='OPS_ADHOC_DA' and original.source_system='OPS_ADHOC_DA'
      and supplement.adhoc_payout_policy='work_day' and original.adhoc_payout_policy='work_day'
      and supplement.location_id=original.location_id
      and lower(supplement.adhoc_client)=lower(original.adhoc_client)
      and upper(btrim(supplement.adhoc_provider_employee_id))=upper(btrim(original.adhoc_provider_employee_id))
      and supplement.adhoc_work_date=original.adhoc_work_date
      and coalesce(supplement.amount,supplement.amount_requested)=new.amount
      and lower(original.status) in ('paid','processed') and lower(original.bank_status)='paid'
      and nullif(btrim(original.utr_cin),'') is not null
      and regexp_replace(upper(original.utr_cin),'[^A-Z0-9]','','g')<>new.normalized_utr
  ) then raise exception 'Supplement review must match the original paid work day and exact amount'; end if;
  return new;
end $guard$;
revoke all on function public.guard_adhoc_supplement_review() from public,anon,authenticated;
drop trigger if exists guard_adhoc_supplement_review on public.payment_adhoc_supplement_reviews;
create trigger guard_adhoc_supplement_review before insert or update or delete on public.payment_adhoc_supplement_reviews
for each row execute function public.guard_adhoc_supplement_review();

do $patch$
declare
  definition text := replace(pg_get_functiondef('public.payment_adhoc_da_guard()'::regprocedure),chr(13),'');
  needle text := $old$and r.adhoc_work_date=new.adhoc_work_date and r.id<>new.id and lower(r.status) in ('processed','paid') and r.source_system='OPS_ADHOC_DA') then$old$;
  replacement text := $new$and r.adhoc_work_date=new.adhoc_work_date and r.id<>new.id and lower(r.status) in ('processed','paid') and r.source_system='OPS_ADHOC_DA'
        -- Reviewed supplements still exclude this work day only once.
        and not exists (
          select 1 from public.payment_adhoc_supplement_reviews review
          where review.company_id=new.company_id and lower(new.bank_status)='paid' and lower(r.bank_status)='paid'
            and (
              (review.payment_request_id=new.id and review.original_payment_request_id=r.id
                and review.amount=coalesce(new.amount,new.amount_requested)
                and review.normalized_utr=regexp_replace(upper(coalesce(new.utr_cin,'')),'[^A-Z0-9]','','g'))
              or (review.payment_request_id=r.id and review.original_payment_request_id=new.id
                and review.amount=coalesce(r.amount,r.amount_requested)
                and review.normalized_utr=regexp_replace(upper(coalesce(r.utr_cin,'')),'[^A-Z0-9]','','g'))
            )
        )) then$new$;
begin
  if position(replacement in definition)>0 then return; end if;
  if position(needle in definition)=0 then raise exception 'Unexpected ad hoc duplicate guard; inspect before applying'; end if;
  execute replace(definition,needle,replacement);
end $patch$;
notify pgrst,'reload schema';
commit;
