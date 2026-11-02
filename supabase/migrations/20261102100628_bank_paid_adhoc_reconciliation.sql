-- A completed bank transfer must be recorded even when the work day was paid before.
begin;
do $patch$
declare
  definition text := replace(pg_get_functiondef('public.payment_adhoc_da_guard()'::regprocedure),chr(13),'');
  duplicate_start text := '      if exists(select 1 from public.payment_requests r where r.company_id=new.company_id and r.location_id=new.location_id';
  duplicate_end text := $end$        raise exception 'This associate already has a paid ad hoc request for this location and work date';
      end if;$end$;
  payroll_start text := '      if exists(select 1 from public.workforce_payout_effective_paid_allocations a where a.company_id=new.company_id and a.credited_workforce_id=new.adhoc_workforce_id';
  payroll_end text := $end$        raise exception 'This work date is already in a finalized Workforce payout. Finance must review it before paying ad hoc';
      end if;$end$;
  evidence_guard text := $guard$      -- Bank-paid reconciliation must record money already transferred.
      if not (coalesce(lower(new.bank_status),'')='paid' and nullif(btrim(new.utr_cin),'') is not null) then
$guard$;
begin
  if position('-- Bank-paid reconciliation must record money already transferred.' in definition)>0 then return; end if;
  if position(duplicate_start in definition)=0 or position(duplicate_end in definition)=0
     or position(payroll_start in definition)=0 or position(payroll_end in definition)=0 then
    raise exception 'Unexpected ad hoc paid-day guard; inspect before applying';
  end if;
  definition := replace(definition,duplicate_start,evidence_guard || duplicate_start);
  definition := replace(definition,duplicate_end,duplicate_end || E'
      end if;');
  definition := replace(definition,payroll_start,evidence_guard || payroll_start);
  definition := replace(definition,payroll_end,payroll_end || E'
      end if;');
  execute definition;
end $patch$;
notify pgrst,'reload schema';
commit;
