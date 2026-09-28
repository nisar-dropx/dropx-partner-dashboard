import { AppShell } from '@/components/app-shell';
import { requirePagePermission } from '@/lib/authorization';
import { currentAdminAccessSurface } from '@/lib/access-surface';
import { notFound } from 'next/navigation';
import { RequestTracker } from '@/components/request-tracker';
export const dynamic='force-dynamic';
export default async function RequestTrackerPage({searchParams={}}:{searchParams?:{type?:string;id?:string;q?:string}}){
 await requirePagePermission('request_tracker','view');
 if(currentAdminAccessSurface()!=='dashboard')notFound();
 return <AppShell active="Request Tracker" pageCode="request_tracker"><RequestTracker initialType={searchParams.type} initialId={searchParams.id} initialQuery={searchParams.q}/></AppShell>;
}
