export type Account = { code: string; name: string; type: string };
export type BankPosition = {
  account_code: string;
  period_end: string;
  closing: string;
  id: string;
};
export type LoanPosition = {
  facility: string;
  lender: string;
  account_code: string;
  as_of: string;
  principal: string;
  interest_due: string;
  emi: string;
  next_due: string | null;
  note: string;
};
export type Summary = {
  journals: number;
  accounts: number;
  imports: number;
  unmatched: number;
  banks: BankPosition[];
  loans: LoanPosition[];
  settings: {
    locked_through: string | null;
    coverage_from: string | null;
    coverage_through: string | null;
  } | null;
};
export type Candidate = {
  id: string;
  date: string;
  reference: string;
  narration: string;
  amount: string;
};
