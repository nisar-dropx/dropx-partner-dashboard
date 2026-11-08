export const lifecycleQueues: Record<string, string> = {
 registration_overdue: "Registration overdue · 15 days", delivery_inactive: "No deliveries · 30 days",
 registration_exception: "Registration exceptions", delivery_exception: "Delivery exceptions",
 inactive: "Inactive", offboarded: "Offboarded", exit_pending: "Exit pending", current: "Current"
};
export type WorkforceLifecycleRow = {
 id: string; dropx_id: string; full_name: string; mobile: string; location_id: string; station_code: string;
 onboarding_status: string; control_status: string; queue: string; reason: string; provider_ids: string | null;
 updated_at: string; version: number; last_delivery: string | null; last_punch: string | null;
 feed_through: string | null; feed_days: number; days_without_delivery: number | null; as_of: string;
};
export function mayManageWorkforceLifecycle(auth: { effectiveRoleCodes?: string[]; roleCode?: string | null; readOnly?: boolean; isPreview?: boolean }, owner=false) {
 if(auth.readOnly || auth.isPreview) return false;
 const allowed = new Set(['FINANCE_HEAD','FINANCE_ACCOUNTS','FINANCE_ACE','FINANCE_FINMGR','OPERATIONS_FINMGR',
 'NATIONAL_HEAD','OPERATIONS_NH','OPERATIONS_NATIONAL_HEAD','WORKFORCE_NH','WORKFORCE_NATIONAL_HEAD','FINANCE_NATIONAL_HEAD',
 'MANAGING_PARTNER','OPERATIONS_MANAGING_PARTNER','WORKFORCE_MANAGING_PARTNER']);
 return owner || [...(auth.effectiveRoleCodes || []),auth.roleCode || ''].some(role=>allowed.has(role.toUpperCase()));
}
export function workforceLifecycleActions(row: Pick<WorkforceLifecycleRow,'queue'|'onboarding_status'>) {
 if(row.queue==='exit_pending') return [];
 if(row.queue==='offboarded') return ['rejoin'];
 if(row.queue==='inactive') return row.onboarding_status==='active' ? ['reactivate','offboard','rejoin'] : ['rejoin','offboard'];
 return ['inactivate','offboard'];
}
export function lifecycleMobile(value: string) {
 const digits=value.replace(/\D/g,'');
 return digits.length===12 && digits.startsWith('91') ? digits.slice(2) : digits;
}
