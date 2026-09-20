import {AppShell} from '@/components/app-shell';
import {WorkforceHoldDesk} from '@/components/workforce-hold-desk';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {manageHold} from './actions';
export const dynamic='force-dynamic';
export default async function WorkforceHolds({searchParams:params={}}:{searchParams?:{status?:string;notice?:string;error?:string}}){
  const auth=await requirePagePermission('ops_salary_hold','access');
  return <AppShell active="Team Ops" pageCode="ops_salary_hold">{params.notice||params.error?<p role="status">{params.error||params.notice}</p>:null}<WorkforceHoldDesk auth={auth} action={manageHold} canEdit={hasPermission(auth,'ops_salary_hold','edit')} reviewer={false} status={params.status}/></AppShell>;
}
