import { AppShell } from '@/components/app-shell';
import { requirePagePermission, hasPermission } from '@/lib/authorization';
import { MailHealthView } from './view';
export const dynamic='force-dynamic';
export default async function Page(){const auth=await requirePagePermission('mail_health','view');return <AppShell active="Mail Health" pageCode="mail_health"><MailHealthView canEdit={hasPermission(auth,'mail_health','edit')&&!auth.isPreview}/></AppShell>;}
