import { AppShell } from "@/components/app-shell";
import { WorkforceConnectCentre } from "@/components/workforce-connect-centre";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";

export default async function WorkforceConnectPage() {
  if (currentAdminAccessSurface() !== "dashboard") notFound();
  const auth = await requirePagePermission("workforce_connect", "view");
  return <AppShell active="Workforce Connect Centre" pageCode="workforce_connect">
    <WorkforceConnectCentre canRespond={!auth.readOnly && !auth.isPreview && hasPermission(auth, "workforce_connect", "edit")} />
  </AppShell>;
}
