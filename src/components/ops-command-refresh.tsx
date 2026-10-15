'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
// Refresh only a visible dashboard. There are no editable forms or mutations here.
export function OpsCommandRefresh(){
  const router=useRouter();
  useEffect(()=>{
    const refresh=()=>{if(document.visibilityState==='visible')router.refresh();};
    const timer=setInterval(refresh,90000);
    document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[router]);
  return null;
}
