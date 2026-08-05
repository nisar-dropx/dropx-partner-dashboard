drop index if exists public.payment_contacts_company_account_ifsc_uidx;
drop index if exists public.payment_contacts_company_upi_uidx;

create unique index payment_contacts_company_user_account_ifsc_uidx
  on public.payment_contacts (
    company_id,
    created_by,
    upper(btrim(bank_account_no)),
    upper(btrim(ifsc))
  )
  where bank_account_no is not null and ifsc is not null;

create unique index payment_contacts_company_user_upi_uidx
  on public.payment_contacts (company_id, created_by, lower(btrim(upi_id)))
  where upi_id is not null;

create index if not exists payment_contacts_company_creator_idx
  on public.payment_contacts (company_id, created_by);
