import {AppShell} from '@/components/app-shell';import {PayoutReviewDesk} from '@/components/payout-review-desk';import {requirePagePermission} from '@/lib/authorization';import {reviewPayout} from './actions';
export const dynamic='force-dynamic';
export default async function Page({searchParams={}}:{searchParams?:{status?:string;q?:string;run?:string;error?:string;notice?:string}}){
 const auth=await requirePagePermission('ops_workforce_losses','access');
 return <AppShell active="Team Ops" pageCode="ops_workforce_losses"><header className="panel-head"><div><h1>Payout review</h1><p>Respond, correct and resolve before Finance release.</p></div></header>{searchParams.notice||searchParams.error?<p role="status">{searchParams.notice||searchParams.error}</p>:null}<PayoutReviewDesk auth={auth} portal="ops" action={reviewPayout} params={searchParams}/></AppShell>;
}
