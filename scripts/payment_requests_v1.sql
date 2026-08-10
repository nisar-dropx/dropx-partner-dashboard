begin;

create table if not exists public.payment_heads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  code text not null,
  name text not null,
  external_id text,
  initial_approval_role_id uuid references public.user_roles(id) on delete set null,
  initial_approval_role_ids uuid[] not null default '{}'::uuid[],
  final_approval_role_id uuid references public.user_roles(id),
  final_approval_role_ids uuid[] not null default '{}'::uuid[],
  payment_process_role_ids uuid[] not null default '{}'::uuid[],
  requires_supporting_document boolean not null default false,
  request_expense_approval boolean not null default false,
  expense_approval_threshold numeric(12,2),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_heads_company_code_key unique (company_id, code)
);

create table if not exists public.payment_head_questions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payment_head_id uuid not null references public.payment_heads(id) on delete cascade,
  question_text text not null,
  answer_type text not null default 'text',
  field_stage text not null default 'expense',
  dropdown_options text,
  is_required boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_head_questions_answer_type_check check (answer_type in ('text', 'number', 'date', 'dropdown', 'textarea', 'yes_no', 'file')),
  constraint payment_head_questions_field_stage_check check (field_stage in ('expense', 'payment'))
);

create table if not exists public.payment_approval_flows (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  step_order integer not null,
  role_id uuid not null references public.user_roles(id),
  is_final boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_approval_flows_company_step_key unique (company_id, step_order)
);

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  request_no text not null,
  location_id uuid references public.stations(id),
  location_code text not null,
  station_code text,
  payment_head_id uuid not null references public.payment_heads(id),
  category text,
  work_date date,
  requested_for_name text,
  amount numeric(12,2),
  amount_requested numeric(12,2),
  payment_mode text not null default 'account_transfer',
  payment_portal text,
  payment_reference text,
  bank_account_no text,
  ifsc text,
  account_holder_name text,
  beneficiary_account_no text,
  beneficiary_account_number text,
  beneficiary_ifsc text,
  beneficiary_account_holder text,
  contact_no text,
  email text,
  remarks text,
  supporting_document_path text,
  status text not null default 'pending',
  approval_status text not null default 'PENDING',
  current_step_order integer not null default 1,
  current_approver_user_id uuid references public.profiles(id),
  current_approver_role_id uuid references public.user_roles(id),
  current_approver_role_ids uuid[] not null default '{}'::uuid[],
  final_approval_role_id uuid references public.user_roles(id),
  final_approval_role_ids uuid[] not null default '{}'::uuid[],
  payment_process_role_ids uuid[] not null default '{}'::uuid[],
  utr_cin text,
  bank_status text,
  bank_processing_remarks text,
  processing_started_at timestamptz,
  processed_at timestamptz,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_requests_company_request_no_key unique (company_id, request_no),
  constraint payment_requests_status_check check (status in ('pending', 'approved', 'processing', 'processed', 'rejected', 'returned', 'cancelled') or status like '%\_APPROVED' escape '\')
);

create table if not exists public.payment_request_approvals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  approver_user_id uuid references public.profiles(id),
  approver_role_id uuid references public.user_roles(id),
  action text not null,
  comments text,
  created_at timestamptz not null default now(),
  constraint payment_request_approvals_action_check check (action in ('approved', 'rejected', 'returned'))
);

create table if not exists public.payment_request_answers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  question_id uuid not null references public.payment_head_questions(id),
  answer_value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_heads add column if not exists company_id uuid;
alter table public.payment_heads add column if not exists code text;
alter table public.payment_heads add column if not exists name text;
alter table public.payment_heads add column if not exists external_id text;
alter table public.payment_heads add column if not exists initial_approval_role_id uuid references public.user_roles(id) on delete set null;
alter table public.payment_heads add column if not exists initial_approval_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_heads add column if not exists final_approval_role_id uuid references public.user_roles(id);
alter table public.payment_heads add column if not exists final_approval_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_heads add column if not exists payment_process_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_heads add column if not exists requires_supporting_document boolean not null default false;
alter table public.payment_heads add column if not exists request_expense_approval boolean not null default false;
alter table public.payment_heads add column if not exists expense_approval_threshold numeric(12,2);
alter table public.payment_heads add column if not exists is_active boolean not null default true;
alter table public.payment_heads add column if not exists sort_order integer not null default 100;
alter table public.payment_heads add column if not exists created_at timestamptz not null default now();
alter table public.payment_heads add column if not exists updated_at timestamptz not null default now();

alter table public.payment_head_questions add column if not exists company_id uuid;
alter table public.payment_head_questions add column if not exists payment_head_id uuid;
alter table public.payment_head_questions add column if not exists question_text text;
alter table public.payment_head_questions add column if not exists answer_type text not null default 'text';
alter table public.payment_head_questions add column if not exists field_stage text not null default 'expense';
alter table public.payment_head_questions add column if not exists dropdown_options text;
alter table public.payment_head_questions add column if not exists is_required boolean not null default true;
alter table public.payment_head_questions add column if not exists sort_order integer not null default 100;
alter table public.payment_head_questions add column if not exists created_at timestamptz not null default now();
alter table public.payment_head_questions add column if not exists updated_at timestamptz not null default now();

alter table public.payment_head_questions drop constraint if exists payment_head_questions_answer_type_check;
alter table public.payment_head_questions
  add constraint payment_head_questions_answer_type_check
  check (answer_type in ('text', 'number', 'date', 'dropdown', 'textarea', 'yes_no', 'file'));

alter table public.payment_head_questions drop constraint if exists payment_head_questions_field_stage_check;
alter table public.payment_head_questions
  add constraint payment_head_questions_field_stage_check
  check (field_stage in ('expense', 'payment'));

alter table public.payment_approval_flows add column if not exists company_id uuid;
alter table public.payment_approval_flows add column if not exists step_order integer;
alter table public.payment_approval_flows add column if not exists role_id uuid;
alter table public.payment_approval_flows add column if not exists is_final boolean not null default false;
alter table public.payment_approval_flows add column if not exists created_at timestamptz not null default now();
alter table public.payment_approval_flows add column if not exists updated_at timestamptz not null default now();

alter table public.payment_requests add column if not exists company_id uuid;
alter table public.payment_requests add column if not exists request_no text;
alter table public.payment_requests add column if not exists location_id uuid;
alter table public.payment_requests add column if not exists location_code text;
alter table public.payment_requests add column if not exists station_code text;
alter table public.payment_requests add column if not exists payment_head_id uuid;
alter table public.payment_requests add column if not exists category text;
alter table public.payment_requests add column if not exists work_date date;
alter table public.payment_requests add column if not exists requested_for_name text;
alter table public.payment_requests add column if not exists amount numeric(12,2);
alter table public.payment_requests add column if not exists amount_requested numeric(12,2);
alter table public.payment_requests add column if not exists payment_mode text;
alter table public.payment_requests add column if not exists payment_portal text;
alter table public.payment_requests add column if not exists payment_reference text;
alter table public.payment_requests add column if not exists bank_account_no text;
alter table public.payment_requests add column if not exists ifsc text;
alter table public.payment_requests add column if not exists account_holder_name text;
alter table public.payment_requests add column if not exists beneficiary_account_no text;
alter table public.payment_requests add column if not exists beneficiary_account_number text;
alter table public.payment_requests add column if not exists beneficiary_ifsc text;
alter table public.payment_requests add column if not exists beneficiary_account_holder text;
alter table public.payment_requests add column if not exists contact_no text;
alter table public.payment_requests add column if not exists email text;
alter table public.payment_requests add column if not exists remarks text;
alter table public.payment_requests add column if not exists supporting_document_path text;
alter table public.payment_requests add column if not exists status text not null default 'pending';
alter table public.payment_requests add column if not exists approval_status text not null default 'PENDING';
alter table public.payment_requests add column if not exists current_step_order integer not null default 1;
alter table public.payment_requests add column if not exists current_approver_user_id uuid references public.profiles(id);
alter table public.payment_requests add column if not exists current_approver_role_id uuid references public.user_roles(id);
alter table public.payment_requests add column if not exists current_approver_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_requests add column if not exists final_approval_role_id uuid references public.user_roles(id);
alter table public.payment_requests add column if not exists final_approval_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_requests add column if not exists payment_process_role_ids uuid[] not null default '{}'::uuid[];
alter table public.payment_requests add column if not exists utr_cin text;
alter table public.payment_requests add column if not exists bank_status text;
alter table public.payment_requests add column if not exists bank_processing_remarks text;
alter table public.payment_requests add column if not exists processing_started_at timestamptz;
alter table public.payment_requests add column if not exists processed_at timestamptz;
alter table public.payment_requests add column if not exists requested_by uuid;
alter table public.payment_requests add column if not exists created_at timestamptz not null default now();
alter table public.payment_requests add column if not exists updated_at timestamptz not null default now();

alter table public.payment_requests alter column amount drop not null;
alter table public.payment_requests alter column bank_account_no drop not null;
alter table public.payment_requests alter column ifsc drop not null;
alter table public.payment_requests alter column account_holder_name drop not null;
alter table public.payment_requests alter column beneficiary_account_no drop not null;
alter table public.payment_requests alter column beneficiary_account_number drop not null;
alter table public.payment_requests alter column beneficiary_ifsc drop not null;
alter table public.payment_requests alter column beneficiary_account_holder drop not null;
alter table public.payment_requests alter column contact_no drop not null;
alter table public.payment_requests alter column email drop not null;

update public.payment_requests
set payment_mode = 'account_transfer'
where payment_mode is null;

alter table public.payment_requests alter column payment_mode set default 'account_transfer';
alter table public.payment_requests alter column payment_mode set not null;

alter table public.payment_requests drop constraint if exists payment_requests_payment_mode_check;
alter table public.payment_requests
  add constraint payment_requests_payment_mode_check
  check (payment_mode in ('account_transfer', 'online_payment'));

do $$
declare
  nullable_bank_column text;
begin
  foreach nullable_bank_column in array array[
    'bank_account_no_encrypted',
    'ifsc_encrypted',
    'account_holder_name_encrypted',
    'beneficiary_account_no_encrypted',
    'beneficiary_account_number_encrypted',
    'beneficiary_ifsc_encrypted',
    'beneficiary_account_holder_encrypted',
    'contact_no_encrypted',
    'email_encrypted'
  ]
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'payment_requests'
        and column_name = nullable_bank_column
    ) then
      execute format('alter table public.payment_requests alter column %I drop not null', nullable_bank_column);
    end if;
  end loop;
end $$;

alter table public.payment_request_answers add column if not exists company_id uuid;
alter table public.payment_request_answers add column if not exists payment_request_id uuid;
alter table public.payment_request_answers add column if not exists question_id uuid;
alter table public.payment_request_answers add column if not exists answer_value text;
alter table public.payment_request_answers add column if not exists file_path text;
alter table public.payment_request_answers add column if not exists file_name text;
alter table public.payment_request_answers add column if not exists file_size bigint;
alter table public.payment_request_answers add column if not exists created_at timestamptz not null default now();
alter table public.payment_request_answers add column if not exists updated_at timestamptz not null default now();

alter table public.payment_request_approvals add column if not exists company_id uuid;
alter table public.payment_request_approvals add column if not exists payment_request_id uuid;
alter table public.payment_request_approvals add column if not exists approver_user_id uuid;
alter table public.payment_request_approvals add column if not exists approver_role_id uuid;
alter table public.payment_request_approvals add column if not exists action text;
alter table public.payment_request_approvals add column if not exists comments text;
alter table public.payment_request_approvals add column if not exists created_at timestamptz not null default now();

alter table public.payment_requests drop constraint if exists payment_requests_category_check;
alter table public.payment_requests alter column category drop not null;

alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'approved', 'processing', 'processed', 'rejected', 'returned', 'cancelled') or status like '%\_APPROVED' escape '\');

alter table public.payment_request_approvals drop constraint if exists payment_request_approvals_action_check;
alter table public.payment_request_approvals
  add constraint payment_request_approvals_action_check
  check (action in ('created', 'submitted', 'approved', 'rejected', 'returned', 'resubmitted', 'processing', 'processed', 'cancelled'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_head_questions_payment_head_id_fkey') then
    alter table public.payment_head_questions
      add constraint payment_head_questions_payment_head_id_fkey
      foreign key (payment_head_id) references public.payment_heads(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_approval_flows_role_id_fkey') then
    alter table public.payment_approval_flows
      add constraint payment_approval_flows_role_id_fkey
      foreign key (role_id) references public.user_roles(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_requests_location_id_fkey') then
    alter table public.payment_requests
      add constraint payment_requests_location_id_fkey
      foreign key (location_id) references public.stations(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_requests_payment_head_id_fkey') then
    alter table public.payment_requests
      add constraint payment_requests_payment_head_id_fkey
      foreign key (payment_head_id) references public.payment_heads(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_request_answers_payment_request_id_fkey') then
    alter table public.payment_request_answers
      add constraint payment_request_answers_payment_request_id_fkey
      foreign key (payment_request_id) references public.payment_requests(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_request_answers_question_id_fkey') then
    alter table public.payment_request_answers
      add constraint payment_request_answers_question_id_fkey
      foreign key (question_id) references public.payment_head_questions(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_request_approvals_payment_request_id_fkey') then
    alter table public.payment_request_approvals
      add constraint payment_request_approvals_payment_request_id_fkey
      foreign key (payment_request_id) references public.payment_requests(id) on delete cascade;
  end if;
end $$;

create index if not exists payment_heads_company_idx on public.payment_heads(company_id);
create index if not exists payment_head_questions_head_idx on public.payment_head_questions(payment_head_id);
create index if not exists payment_requests_company_status_idx on public.payment_requests(company_id, status);
create index if not exists payment_requests_current_approver_idx on public.payment_requests(company_id, current_approver_user_id, status);
create index if not exists payment_request_answers_request_idx on public.payment_request_answers(payment_request_id);
create index if not exists payment_request_approvals_request_idx on public.payment_request_approvals(payment_request_id);

insert into storage.buckets (id, name, public)
values ('payment-request-documents', 'payment-request-documents', false)
on conflict (id) do nothing;

alter table public.payment_heads enable row level security;
alter table public.payment_head_questions enable row level security;
alter table public.payment_approval_flows enable row level security;
alter table public.payment_requests enable row level security;
alter table public.payment_request_answers enable row level security;
alter table public.payment_request_approvals enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_heads' and policyname = 'service_role_payment_heads_all') then
    create policy "service_role_payment_heads_all" on public.payment_heads for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_head_questions' and policyname = 'service_role_payment_head_questions_all') then
    create policy "service_role_payment_head_questions_all" on public.payment_head_questions for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_approval_flows' and policyname = 'service_role_payment_approval_flows_all') then
    create policy "service_role_payment_approval_flows_all" on public.payment_approval_flows for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_requests' and policyname = 'service_role_payment_requests_all') then
    create policy "service_role_payment_requests_all" on public.payment_requests for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_request_answers' and policyname = 'service_role_payment_request_answers_all') then
    create policy "service_role_payment_request_answers_all" on public.payment_request_answers for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_request_approvals' and policyname = 'service_role_payment_request_approvals_all') then
    create policy "service_role_payment_request_approvals_all" on public.payment_request_approvals for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;

insert into public.app_pages (company_id, code, name, sort_order, is_active, updated_at)
select companies.id, page_data.code, page_data.name, page_data.sort_order, true, now()
from public.companies
cross join (
  values
    ('expense_requests', 'Expense Request', 105),
    ('payment_requests', 'Payment Requests', 106),
    ('payment_approvals', 'Payment Approvals', 107),
    ('payment_process', 'Payment Process', 108),
    ('payment_reports', 'Payment Report', 109),
    ('master_payment_heads', 'Payment Heads', 125)
) as page_data(code, name, sort_order)
where not exists (
  select 1
  from public.app_pages pages
  where pages.company_id = companies.id
    and pages.code = page_data.code
);

update public.app_pages pages
set name = page_data.name,
    sort_order = page_data.sort_order,
    is_active = true,
    updated_at = now()
from (
  values
    ('expense_requests', 'Expense Request', 105),
    ('payment_requests', 'Payment Requests', 106),
    ('payment_approvals', 'Payment Approvals', 107),
    ('payment_process', 'Payment Process', 108),
    ('payment_reports', 'Payment Report', 109),
    ('master_payment_heads', 'Payment Heads', 125)
) as page_data(code, name, sort_order)
where pages.code = page_data.code
  and pages.company_id is not null;

insert into public.role_page_permissions (company_id, role_id, page_id, can_view, can_add, can_edit)
select roles.company_id, roles.id, pages.id, true, true, true
from public.user_roles roles
join public.app_pages pages
  on pages.company_id = roles.company_id
where roles.code = 'OWNER'
  and pages.code in (
    'expense_requests',
    'payment_requests',
    'payment_approvals',
    'payment_process',
    'payment_reports',
    'master_payment_heads'
  )
  and not exists (
    select 1
    from public.role_page_permissions permissions
    where permissions.company_id = roles.company_id
      and permissions.role_id = roles.id
      and permissions.page_id = pages.id
  );

commit;
