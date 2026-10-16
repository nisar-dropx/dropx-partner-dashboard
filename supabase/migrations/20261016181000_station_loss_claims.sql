begin;
-- Station loss claims: a loss a station finds itself (cash short, asset lost, damage), run as one process.
--
--   station raises ──► submitted ──CM approves──► approved ──► Team Ops loss case ──► recovery plan ──► payroll
--                          │  ├─CM returns──► returned ──station resubmits──► submitted
--                          │  └─CM rejects──► rejected
--                          └─station withdraws──► withdrawn
--
-- Approval creates a 'station' case in the Team Ops loss ledger (nl_loss_month_cases), so people are
-- assigned, full or recurring debit applies, the salary cap and exit settlement apply, and the deduction
-- appears in the Recovery Ledger exactly like an Amazon NL / SLP loss. Every step is one row in the
-- append-only ops_station_loss_claim_events. The cluster manager of the station decides (checked by the
-- app); this database never lets the person who raised a claim decide it.

alter table public.nl_loss_month_cases drop constraint if exists nl_loss_month_cases_report_check;
alter table public.nl_loss_month_cases add constraint nl_loss_month_cases_report_check check (report in ('nl','slp','station'));

create or replace function public.nl_case_recoverable(co uuid,p_report text,status text) returns boolean language sql stable security invoker set search_path=public as $$
 -- SLP files list only amounts Amazon recovers; a station case is recoverable once its claim is approved.
 select p_report='slp' or (p_report='station' and status='Approved') or (p_report='nl' and nl_is_recoverable(co,status))
$$;

create table if not exists public.ops_station_loss_claims (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 station_id uuid not null references public.stations(id),
 station_code text not null,
 reference text not null check (reference ~ '^[A-Z0-9][A-Z0-9/_.-]{2,59}$'),
 incident_date date not null,
 category text not null check (category in ('cash_shortage','cod_shortage','asset_loss','shipment_loss','damage','other')),
 amount numeric(14,2) not null check (amount>0 and amount<=1000000),
 description text not null check (length(btrim(description)) between 10 and 2000),
 evidence_url text check (evidence_url is null or evidence_url ~ '^https://[^[:space:]]+$'),
 people_involved text check (people_involved is null or length(people_involved)<=500),
 status text not null default 'submitted' check (status in ('submitted','returned','approved','rejected','withdrawn')),
 raised_by uuid not null, raised_by_name text not null, raised_at timestamptz not null default now(),
 decided_by uuid, decided_by_name text, decided_at timestamptz, decision_note text,
 case_month text, case_key text,
 version int not null default 1,
 updated_at timestamptz not null default now(),
 unique (company_id, reference)
);
create index if not exists ops_station_loss_claims_station_idx on public.ops_station_loss_claims(company_id, station_id, status, raised_at desc);

create table if not exists public.ops_station_loss_claim_events (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null, claim_id uuid not null references public.ops_station_loss_claims(id) on delete cascade,
 action text not null, from_status text, to_status text not null,
 actor_id uuid, actor_name text, note text, created_at timestamptz not null default now()
);
create index if not exists ops_station_loss_claim_events_claim_idx on public.ops_station_loss_claim_events(company_id, claim_id, created_at);

create or replace function public.ops_station_loss_claim_events_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'Claim history cannot be changed.'; end $$;
drop trigger if exists ops_station_loss_claim_events_immutable on public.ops_station_loss_claim_events;
create trigger ops_station_loss_claim_events_immutable before update or delete on public.ops_station_loss_claim_events
 for each row execute function public.ops_station_loss_claim_events_immutable();

alter table public.ops_station_loss_claims enable row level security;
alter table public.ops_station_loss_claim_events enable row level security;
revoke all on public.ops_station_loss_claims, public.ops_station_loss_claim_events from public, anon, authenticated;
grant all on public.ops_station_loss_claims to service_role;
grant select, insert on public.ops_station_loss_claim_events to service_role;

create or replace function public.station_claim_submit(p_company uuid,p_station uuid,p_station_code text,p_reference text,p_incident_date date,p_category text,
 p_amount numeric,p_description text,p_evidence_url text,p_people text,p_actor uuid,p_name text)
returns public.ops_station_loss_claims language plpgsql security invoker set search_path=public as $$
declare saved ops_station_loss_claims; ref text:=upper(btrim(coalesce(p_reference,'')));
begin
 if not exists(select 1 from stations where company_id=p_company and id=p_station) then raise exception 'Choose one of your stations.'; end if;
 if ref !~ '^[A-Z0-9][A-Z0-9/_.-]{2,59}$' then raise exception 'Use a reference of 3–60 letters, numbers, / _ . or -.'; end if;
 if p_incident_date is null or p_incident_date>(now() at time zone 'Asia/Kolkata')::date or p_incident_date<(now() at time zone 'Asia/Kolkata')::date-180 then raise exception 'The incident date must be within the last 180 days.'; end if;
 if p_amount is null or p_amount<=0 or p_amount>1000000 or round(p_amount,2)<>p_amount then raise exception 'Enter a loss amount between ₹0.01 and ₹10,00,000.'; end if;
 if exists(select 1 from ops_station_loss_claims where company_id=p_company and reference=ref) then raise exception 'Reference % is already used by another claim.',ref; end if;
 insert into ops_station_loss_claims(company_id,station_id,station_code,reference,incident_date,category,amount,description,evidence_url,people_involved,raised_by,raised_by_name)
 values(p_company,p_station,upper(btrim(p_station_code)),ref,p_incident_date,p_category,p_amount,btrim(p_description),nullif(btrim(coalesce(p_evidence_url,'')),''),nullif(btrim(coalesce(p_people,'')),''),p_actor,p_name)
 returning * into saved;
 insert into ops_station_loss_claim_events(company_id,claim_id,action,to_status,actor_id,actor_name,note) values(p_company,saved.id,'raised','submitted',p_actor,p_name,saved.description);
 return saved;
end $$;

-- approve | reject | return (CM) · resubmit | withdraw (raiser). Approval opens the Team Ops loss case.
create or replace function public.station_claim_transition(p_company uuid,p_claim uuid,p_action text,p_version int,p_actor uuid,p_name text,p_note text default null,p_patch jsonb default '{}')
returns public.ops_station_loss_claims language plpgsql security invoker set search_path=public as $$
declare c ops_station_loss_claims; target text; note text:=nullif(btrim(coalesce(p_note,'')),''); saved ops_station_loss_claims; v_month text; v_key text;
begin
 select * into c from ops_station_loss_claims where company_id=p_company and id=p_claim for update;
 if not found then raise exception 'Claim was not found.'; end if;
 if c.version<>p_version then raise exception 'Someone else updated this claim. Refresh and try again.'; end if;
 if note is not null and length(note)>1000 then raise exception 'Keep the note under 1,000 characters.'; end if;
 target:=case
  when p_action='approve' and c.status='submitted' then 'approved'
  when p_action='reject' and c.status='submitted' then 'rejected'
  when p_action='return' and c.status='submitted' then 'returned'
  when p_action='resubmit' and c.status='returned' then 'submitted'
  when p_action='withdraw' and c.status in ('submitted','returned') then 'withdrawn' end;
 if target is null then raise exception 'This claim is now %, so it cannot be changed this way. Refresh to see its latest state.',c.status; end if;
 if p_action in ('approve','reject','return') and p_actor=c.raised_by then raise exception 'You raised this claim, so the cluster manager must decide it.'; end if;
 if p_action in ('resubmit','withdraw') and p_actor<>c.raised_by then raise exception 'Only the person who raised this claim can do that.'; end if;
 if p_action in ('reject','return') and (note is null or length(note)<5) then raise exception 'Add a reason (at least 5 characters).'; end if;
 if p_action='resubmit' then
  if coalesce(p_patch->>'amount','') !~ '^\d+(\.\d{1,2})?$' or (p_patch->>'amount')::numeric<=0 or (p_patch->>'amount')::numeric>1000000 then raise exception 'Enter a loss amount between ₹0.01 and ₹10,00,000.'; end if;
  if length(btrim(coalesce(p_patch->>'description',''))) not between 10 and 2000 then raise exception 'Describe the loss (10–2,000 characters).'; end if;
  if nullif(btrim(coalesce(p_patch->>'evidence_url','')),'') is not null and btrim(p_patch->>'evidence_url') !~ '^https://[^[:space:]]+$' then raise exception 'Evidence must be an https:// link.'; end if;
 end if;
 if target='approved' then
  v_month:=to_char(c.incident_date,'YYYY-MM'); v_key:='station:'||c.reference;
  insert into nl_loss_month_cases(company_id,report,month,case_key,station_code,amount,source_status,details,source_present,source_file)
  values(p_company,'station',v_month,v_key,c.station_code,c.amount,'Approved',
   jsonb_build_object('tid',c.reference,'category',initcap(replace(c.category,'_',' ')),'remarks',c.description,'impact_date',c.incident_date,
    'da_name',c.people_involved,'claim_id',c.id,'evidence_url',c.evidence_url,'approved_by',p_name),true,'station-claim')
  on conflict(company_id,month,case_key) do update set amount=excluded.amount,source_status='Approved',source_present=true,details=excluded.details,last_seen_at=now();
 end if;
 update ops_station_loss_claims set status=target,version=version+1,updated_at=now(),
  decided_by=case when p_action in ('approve','reject','return') then p_actor else decided_by end,
  decided_by_name=case when p_action in ('approve','reject','return') then p_name else decided_by_name end,
  decided_at=case when p_action in ('approve','reject','return') then now() else decided_at end,
  decision_note=case when p_action in ('approve','reject','return') then note else decision_note end,
  amount=case when p_action='resubmit' then (p_patch->>'amount')::numeric else amount end,
  description=case when p_action='resubmit' then btrim(p_patch->>'description') else description end,
  evidence_url=case when p_action='resubmit' then nullif(btrim(coalesce(p_patch->>'evidence_url','')),'') else evidence_url end,
  case_month=coalesce(v_month,case_month), case_key=coalesce(v_key,case_key)
 where id=p_claim returning * into saved;
 insert into ops_station_loss_claim_events(company_id,claim_id,action,from_status,to_status,actor_id,actor_name,note)
 values(p_company,p_claim,p_action,c.status,target,p_actor,p_name,case when p_action='resubmit' then coalesce(note,'Resubmitted with ₹'||saved.amount) else note end);
 return saved;
end $$;

revoke all on function public.station_claim_submit(uuid,uuid,text,text,date,text,numeric,text,text,text,uuid,text),
 public.station_claim_transition(uuid,uuid,text,int,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.station_claim_submit(uuid,uuid,text,text,date,text,numeric,text,text,text,uuid,text),
 public.station_claim_transition(uuid,uuid,text,int,uuid,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
