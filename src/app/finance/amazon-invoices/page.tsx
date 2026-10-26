import { AppShell } from '@/components/app-shell';
import { hasPermission } from '@/lib/authorization';
import { invoiceContext } from '@/lib/finance/amazon-invoices/server';
import { AmazonInvoicesWorkspace } from './workspace';
import '../final-pnl/final-pnl.css';
import './amazon-invoices.css';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const TABS = new Set(['queue', 'catalog', 'tally', 'automation']);

export default async function Page({
  searchParams = {},
}: {
  searchParams?: { tab?: string };
}) {
  const ctx = await invoiceContext();
  const tab = TABS.has(searchParams.tab || '') ? (searchParams.tab as string) : 'queue';
  const canEdit = hasPermission(ctx.authorization, 'finance_pnl', 'edit');

  return (
    <AppShell active="Amazon invoices" pageCode="finance_pnl">
      <AmazonInvoicesWorkspace initialTab={tab} canEdit={canEdit} />
    </AppShell>
  );
}
