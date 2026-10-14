// Shared, dependency-free policy. Display labels never grant preview access.
export const connectPreviewCookieName = "dropx_connect_preview_v1";
export const previewReadOnlyMessage = "You are viewing another profile. Exit preview to make changes.";
export const previewProfileTables = {
  user: "profiles", employee: "employees", contractor: "contractors", workforce: "workforce", vendor: "vendors"
} as const;
export type PreviewProfileType = keyof typeof previewProfileTables;
export type PreviewTarget = { companyId: string; profileType: PreviewProfileType; id: string };
export function validPreviewTarget(value: unknown): value is PreviewTarget {
  const v = value as PreviewTarget | null;
  return Boolean(v && Object.hasOwn(previewProfileTables, v.profileType) &&
    /^[0-9a-f-]{36}$/i.test(v.id) && /^[0-9a-f-]{36}$/i.test(v.companyId));
}
export function previewRoleAllowed(masterOwner: boolean, roleCode?: string | null, designationCode?: string | null) {
  // HRM is the HR Head designation; the prefixed codes are the same seat in
  // product access masters. Do not grant access from a display name or general HR role.
  const hrHeadCodes = ["HRM", "HR_HEAD", "PEOPLE_HRM", "OPERATIONS_HRM", "WORKFORCE_HRM", "RECRUIT_HRM"];
  const hrHead = hrHeadCodes.includes(designationCode ?? "") ||
    hrHeadCodes.includes(roleCode ?? "") || roleCode === "HR_HAEAD"; // Existing access-master spelling.
  return masterOwner || roleCode === "OWNER" || roleCode === "TECH" ||
    designationCode === "FSD" || designationCode === "FINMGR" || hrHead;
}
export function blocksPreviewMutation(method: string, path: string, preview: boolean) {
  return preview && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    path !== "/api/connect/preview" && !(path === "/api/connect/auth/session" && method === "DELETE");
}
export function samePreviewTarget(a: PreviewTarget, b: { companyId: string; profileType: string; id: string }) {
  return a.companyId === b.companyId && a.profileType === b.profileType && a.id === b.id;
}
