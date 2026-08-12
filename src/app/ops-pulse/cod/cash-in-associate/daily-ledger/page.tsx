import { redirect } from "next/navigation";

/** Day-wise ledger now lives on each station page (`?view=ledger`). */
export default function CiaDailyLedgerRedirectPage() {
  redirect("/cod/cash-in-associate");
}
