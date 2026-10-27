import { AppShell } from "@/components/app-shell";
import { MarshInsurancePanel } from "@/components/marsh-insurance-panel";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";
import { getMarshSessionStatus, type MarshSessionView } from "../marsh-actions";

export const dynamic = "force-dynamic";

export default async function MarshInsuranceSettingsPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const permission = authorization.permissions.app_settings;
  let initial: MarshSessionView = {
    credentialsConfigured: false,
    status: "idle",
    challengeId: null,
    lastError: null,
    updatedAt: null,
    uploadedAt: null,
    cookiePresent: false,
    cookieAgeSeconds: null,
    driveConfigured: false,
  };
  let loadError: string | null = null;
  try {
    initial = await getMarshSessionStatus();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Unable to load Marsh session status.";
  }

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Configuration"
        title="Marsh Insurance"
        subtitle="Connect Qover once with email OTP. Session cookies power enroll, terminate, and GMC/GPA ecard sync to DropX One."
        action={
          <div className="page-actions">
            <PendingLink className="button secondary compact" href="/settings">
              Back to Settings
            </PendingLink>
          </div>
        }
      />
      {loadError ? (
        <div className="alert danger">
          <strong>Worker unavailable</strong>
          <span>{loadError}</span>
        </div>
      ) : (
        <MarshInsurancePanel canEdit={Boolean(permission?.canEdit || permission?.canAdd)} initial={initial} />
      )}
    </AppShell>
  );
}
