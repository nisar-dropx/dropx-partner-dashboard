'use client';
import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
export function OpsLeaveRefresh({ checkedAt }: { checkedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!pending && document.visibilityState === 'visible' && navigator.onLine) startTransition(() => router.refresh());
    }, 60000);
    return () => window.clearInterval(timer);
  }, [pending, router]);
  return <div className="oul-refresh"><span>Checked {new Date(checkedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })} · updates every minute</span>
    <button className="button secondary" disabled={pending} onClick={() => startTransition(() => router.refresh())}><RefreshCw size={14} />{pending ? 'Refreshing…' : 'Refresh'}</button></div>;
}
