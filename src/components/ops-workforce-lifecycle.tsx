import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { OpsWorkforceNavigation } from '@/components/ops-workforce-navigation';
import { WorkforceLifecycleDesk } from '@/components/workforce-lifecycle-desk';
import { requirePagePermission } from '@/lib/authorization';
export async function OpsWorkforceLifecycle({selectedId}:{selectedId?:string}) {
 await requirePagePermission('delivery_associates','access');
 return <AppShell active="Workforce Register" pageCode="delivery_associates"><PageHead eyebrow="Workforce" title="Lifecycle & exits" subtitle="Inactive associates, overdue registration, exceptions and rejoining."/><OpsWorkforceNavigation lifecycle/><WorkforceLifecycleDesk selectedId={selectedId}/></AppShell>;
}
