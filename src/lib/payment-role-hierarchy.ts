export type PaymentApprovalRole = {
  id: string;
  parent_role_id: string | null;
};

export function isRoleAtOrAboveFinalApprover(
  actorRoleId: string | null | undefined,
  finalRoleIds: string[],
  roles: PaymentApprovalRole[]
) {
  if (!actorRoleId || !finalRoleIds.length) return false;

  const parentByRoleId = new Map(roles.map((role) => [role.id, role.parent_role_id]));

  return finalRoleIds.some((finalRoleId) => {
    let roleId: string | null | undefined = finalRoleId;
    const visited = new Set<string>();

    while (roleId && !visited.has(roleId)) {
      if (roleId === actorRoleId) return true;
      visited.add(roleId);
      roleId = parentByRoleId.get(roleId);
    }

    return false;
  });
}
