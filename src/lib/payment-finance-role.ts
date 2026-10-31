/** Roles that settle payments — never approval-step candidates (except DropX One reimbursement). */
const FINANCE_OR_ACCOUNTS_ROLE_CODE =
  /(^|_)(FIN|FINMGR|FINANCE|ACCOUNT|ACCOUNTS)(_|$)/;

export function isFinanceOrAccountsRoleCode(code: string | null | undefined) {
  return FINANCE_OR_ACCOUNTS_ROLE_CODE.test(String(code ?? "").trim().toUpperCase());
}
