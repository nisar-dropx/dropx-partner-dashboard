import { getSignedInPreviewProfile, selectedPreviewUserId } from "@/lib/portal-preview";
import { OwnerPreviewSwitcher } from "@/components/owner-preview-switcher";

export async function PreviewRecovery() {
  const viewer = await getSignedInPreviewProfile();
  return viewer && selectedPreviewUserId(viewer.id)
    ? <OwnerPreviewSwitcher active name="unavailable or restricted user" />
    : null;
}
