-- Enforce verified available payroll for active People as well as Workforce/leavers.
-- Patch the installed function to preserve later lifecycle and bank-lock safeguards.
do $migration$
declare
  fn regprocedure := 'public.save_nl_recovery(uuid,text,text,integer,text,text,jsonb,text,uuid,text,jsonb,jsonb)'::regprocedure;
  body text;
begin
  select replace(pg_get_functiondef(fn),chr(13),'') into body;
  if position($old0$if a->>'employee_ref' like 'workforce:%' or not coalesce((person->>'is_active')::boolean,false) or pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)) then -- People pay checked in payroll$old0$ in body)>0 then
    body:=replace(body,$old0$if a->>'employee_ref' like 'workforce:%' or not coalesce((person->>'is_active')::boolean,false) or pay_month<nl_recovery_deduction_month(c.report,c.month,now(),c.final_seen_at,'current_month',coalesce((policy->>'payroll_cutoff_day')::int,5)) then -- People pay checked in payroll$old0$,$new0$if true then -- Every profile requires verified available payroll before allocation$new0$);
  elsif position($new0$if true then -- Every profile requires verified available payroll before allocation$new0$ in body)=0 then
    raise exception 'Unexpected save_nl_recovery definition: payable guard 0';
  end if;
  if position($old1$raise exception 'Selected payroll month salary payable is unavailable. Complete payroll or payout mapping first.';$old1$ in body)>0 then
    body:=replace(body,$old1$raise exception 'Selected payroll month salary payable is unavailable. Complete payroll or payout mapping first.';$old1$,$new1$raise exception '%: Recovery unavailable: payroll for % is not ready. Refresh eligibility and review payroll or payout mapping.',person->>'employee_code',pay_month;$new1$);
  elsif position($new1$raise exception '%: Recovery unavailable: payroll for % is not ready. Refresh eligibility and review payroll or payout mapping.',person->>'employee_code',pay_month;$new1$ in body)=0 then
    raise exception 'Unexpected save_nl_recovery definition: payable guard 1';
  end if;
  if body ~ $pattern$if\s+round\(monthly::numeric/100,2\)>cap\s+and\s+\(not\s+coalesce\(\(person\->>'is_active'\)::boolean,false\)\s+or\s+pay_month<nl_recovery_deduction_month\(c\.report,c\.month,now\(\),c\.final_seen_at,'current_month',coalesce\(\(policy\->>'payroll_cutoff_day'\)::int,5\)\)\)\s+then\s+raise\s+exception\s+'%:\s+maximum\s+available\s+recovery\s+is\s+₹%\s+in\s+%\.\s+Reduce\s+this\s+share\s+or\s+select\s+another\s+open\s+month\.',person\->>'employee_code',cap,pay_month;\s+end\s+if;\s+if\s+round\(monthly::numeric/100,2\)>cap\s+then\s+raise\s+exception\s+'The\s+monthly\s+recovery\s+of\s+₹%\s+for\s+%\s+is\s+more\s+than\s+the\s+%\s+salary\s+limit\s+of\s+₹%\.\s+Spread\s+it\s+over\s+more\s+instalments%\.',\s+round\(monthly::numeric/100,2\),person\->>'employee_code',\s+'available\-pay',cap,\s+'';\s+end\s+if;$pattern$ then
    body:=regexp_replace(body,$pattern$if\s+round\(monthly::numeric/100,2\)>cap\s+and\s+\(not\s+coalesce\(\(person\->>'is_active'\)::boolean,false\)\s+or\s+pay_month<nl_recovery_deduction_month\(c\.report,c\.month,now\(\),c\.final_seen_at,'current_month',coalesce\(\(policy\->>'payroll_cutoff_day'\)::int,5\)\)\)\s+then\s+raise\s+exception\s+'%:\s+maximum\s+available\s+recovery\s+is\s+₹%\s+in\s+%\.\s+Reduce\s+this\s+share\s+or\s+select\s+another\s+open\s+month\.',person\->>'employee_code',cap,pay_month;\s+end\s+if;\s+if\s+round\(monthly::numeric/100,2\)>cap\s+then\s+raise\s+exception\s+'The\s+monthly\s+recovery\s+of\s+₹%\s+for\s+%\s+is\s+more\s+than\s+the\s+%\s+salary\s+limit\s+of\s+₹%\.\s+Spread\s+it\s+over\s+more\s+instalments%\.',\s+round\(monthly::numeric/100,2\),person\->>'employee_code',\s+'available\-pay',cap,\s+'';\s+end\s+if;$pattern$,$replacement$if round(monthly::numeric/100,2)>cap then
          raise exception '%: maximum available recovery is ₹% in %. Requested ₹%. Reduce this share or select another open month.',
            person->>'employee_code',cap,pay_month,round(monthly::numeric/100,2);
        end if;$replacement$);
  elsif position($applied$if round(monthly::numeric/100,2)>cap then
          raise exception '%: maximum available recovery is ₹% in %. Requested ₹%. Reduce this share or select another open month.',
            person->>'employee_code',cap,pay_month,round(monthly::numeric/100,2);
        end if;$applied$ in body)=0 then
    raise exception 'Unexpected save_nl_recovery definition: payable guard 2';
  end if;
  execute body;
end $migration$;
