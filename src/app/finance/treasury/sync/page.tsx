import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { booksContext } from "@/lib/finance360/server";
export const dynamic = "force-dynamic";
export default async function AccountingSyncPage() {
  await booksContext();
  return (
    <AppShell active="Cash & Reconciliation" pageCode="finance_books">
      <PageHead
        eyebrow="DROPX FINANCE"
        title="Bank & Tally sync"
        subtitle="Collect bank evidence through your browser sessions and review it before importing."
        action={<Link href="/finance/treasury">Cash & reconciliation</Link>}
      />
      <iframe
        title="Bank and Tally sync workspace"
        src="/api/finance/accounting-sync/console"
        style={{ width: "100%", minHeight: "1100px", border: 0 }}
      />
    </AppShell>
  );
}
