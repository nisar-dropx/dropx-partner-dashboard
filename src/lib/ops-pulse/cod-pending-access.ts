import {hasPermission,type AuthorizationContext} from '@/lib/authorization';

export function isCodLocationRole(code:string|null|undefined) {
  return /(^|_)LOCATION$/.test(String(code||'').trim().toUpperCase());
}

/** Daily COD Pending is a management report; other COD permissions are unchanged. */
export function canAccessDailyCodPending(auth:AuthorizationContext) {
  return ![auth.roleCode,...(auth.effectiveRoleCodes||[])].some(isCodLocationRole)
    && hasPermission(auth,'cod_reports','access');
}
