type Scope={userId:string;readOnly?:boolean;hasAllLocationAccess:boolean;locationScopeIds:string[];effectiveRoleIds:string[];roleId?:string|null};
type Request={location_id?:string|null;status?:string|null;approval_status?:string|null;payment_process_role_ids?:string[]|null;current_approver_user_id?:string|null;current_approver_role_ids?:string[]|null};
/** Applies to manual processing, bank uploads and bank-file export alike. */
export function canProcessPayment(scope:Scope,request:Request,owner:boolean) {
  if(scope.readOnly) return false;
  if(!scope.hasAllLocationAccess && (!request.location_id || !scope.locationScopeIds.includes(request.location_id))) return false;
  const roles=scope.effectiveRoleIds.length ? scope.effectiveRoleIds : scope.roleId ? [scope.roleId]:[];
  if(!owner && !(request.payment_process_role_ids ?? []).some(id=>roles.includes(id))) return false;
  const status=String(request.status ?? "").toLowerCase();
  if(!["approved","processing","owner_approved"].includes(status)) return false;
  if(!owner && request.approval_status==="RE_APPROVED" && request.current_approver_user_id!==scope.userId && !(request.current_approver_role_ids ?? []).some(id=>roles.includes(id))) return false;
  return true;
}
