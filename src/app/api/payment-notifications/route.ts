import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { emptyPaymentNotificationSnapshot, loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";
import {currentAccessSurface} from '@/lib/access-surface';
import {loadAmazonDaAttention} from '@/lib/amazon-da-attention';

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) {
    return NextResponse.json(emptyPaymentNotificationSnapshot(), { status: 401 });
  }

  const [snapshot,bgc] = await Promise.all([loadPaymentNotificationSnapshot(authorization),currentAccessSurface()==='ops'?loadAmazonDaAttention(authorization).catch(()=>null):null]);
  if(!bgc?.count)return NextResponse.json(snapshot);
  return NextResponse.json({...snapshot,total:snapshot.total+bgc.count,badges:{...snapshot.badges,delivery_associates:bgc.count,workforce:(snapshot.badges.workforce||0)+bgc.count},items:[...snapshot.items,{key:'idfy',label:'IDfy insufficiencies',detail:`${bgc.count} associates need information`,count:bgc.count,href:bgc.href}]});
}
