alter table public.payment_contacts
  add column if not exists upi_id text;

alter table public.payment_contacts
  alter column bank_account_no drop not null,
  alter column ifsc drop not null;

drop index if exists public.payment_contacts_company_account_ifsc_uidx;

create unique index if not exists payment_contacts_company_account_ifsc_uidx
  on public.payment_contacts (company_id, upper(btrim(bank_account_no)), upper(btrim(ifsc)))
  where bank_account_no is not null and ifsc is not null;

create unique index if not exists payment_contacts_company_upi_uidx
  on public.payment_contacts (company_id, lower(btrim(upi_id)))
  where upi_id is not null;

alter table public.payment_contacts
  drop constraint if exists payment_contacts_payment_detail_check;

alter table public.payment_contacts
  add constraint payment_contacts_payment_detail_check check (
    (upi_id is not null and bank_account_no is null and ifsc is null)
    or
    (upi_id is null and bank_account_no is not null and ifsc is not null)
  );
