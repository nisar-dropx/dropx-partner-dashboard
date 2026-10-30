-- Match the canonical lookup expression used by both ownership checks and the
-- finalizer. Raw-reference indexes cannot serve these normalized comparisons.
create index if not exists payment_requests_company_canonical_reference_idx
  on public.payment_requests(company_id, public.workforce_payout_bank_reference_canonical(request_no));
create index if not exists payroll_bank_lines_company_canonical_reference_idx
  on public.hr_payroll_bank_lines(company_id, public.workforce_payout_bank_reference_canonical(reference));
