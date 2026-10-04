import { redirect } from "next/navigation";
import { FleetControlDashboard } from "@/components/fleet-control-dashboard";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership, loadFleetControlData } from "@/lib/fleet-control";
import { fleetAccessPageCodes } from "@/lib/access-surface";
import { signOut } from "@/app/login/actions";
import { approveFleetPayment, rejectFleetPayment, returnFleetPayment } from "./actions";
import "./fleet-control.css";

export const dynamic = "force-dynamic";

type SearchParams = {
  section?: string;
  notice?: string;
  error?: string;
  request?: string;
  master?: string;
};

export default async function FleetControlPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login?next=/fleet-control");
  const companyId = requireCompanyId(authorization);
  const hasMembership = authorization.isMasterOwner || await hasActiveFleetMembership(companyId, authorization.userId);
  const canEnter = hasMembership && fleetAccessPageCodes.some((code) => hasPermission(authorization, code, "access"));
  if (!canEnter) redirect("/unauthorized?page=fleet_action_center&reason=access");
  const data = await loadFleetControlData(companyId, authorization);

  return (
    <FleetControlDashboard
      approveAction={approveFleetPayment}
      data={data}
      initialRequestId={searchParams?.request}
      initialMasterTab={searchParams?.master}
      initialSection={searchParams?.section}
      message={searchParams?.error ? { type: "error", text: searchParams.error } : searchParams?.notice ? { type: "notice", text: searchParams.notice } : null}
      rejectAction={rejectFleetPayment}
      returnAction={returnFleetPayment}
      signOutAction={signOut}
    />
  );
}
