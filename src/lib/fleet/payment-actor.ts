import {getAuthorization} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {fleetAuditContext} from './audit-context';
/** Actor comes from the verified session, never a hidden field or an old row's creator. */
export async function withPaymentActor<T>(action:string,run:()=>Promise<T>):Promise<T> {
  const auth=await getAuthorization();
  if(!auth)throw new Error('Your session has expired. Sign in again.');
  if(auth.readOnly)throw new Error('Exit user preview before changing a payment.');
  const companyId=requireCompanyId(auth),parent=fleetAuditContext.getStore();
  return fleetAuditContext.run({actorId:auth.userId,actorLabel:auth.fullName||auth.email||'User',viewerId:auth.viewerUserId||null,
    companyId,action:`payment.${action}`,route:parent?.route||`/payments/${action}`,requestId:parent?.requestId||crypto.randomUUID()},run);
}
