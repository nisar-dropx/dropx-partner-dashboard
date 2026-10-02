import {hasPermission,type AuthorizationContext} from '@/lib/authorization';
import {isCodLocationRole} from './cod-pending-access';

export function canReviewCodSlip(auth:AuthorizationContext) {
 return !auth.readOnly
  && !auth.isPreview
  && Boolean(auth.companyId)
  && ![auth.roleCode,...(auth.effectiveRoleCodes||[])].some(isCodLocationRole)
  && hasPermission(auth,'cod_validation','edit');
}

export const manualReviewReason={
 Valid:'CMS / bank deposit slip confirmed; amount matches; seal is visible.',
 'Not valid':'Correction required.'
} as const;
