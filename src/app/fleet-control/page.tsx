import { redirect } from "next/navigation";
import { FleetControlDashboard } from "@/components/fleet-control-dashboard";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership, loadFleetControlData } from "@/lib/fleet-control";
import { approveFleetPayment, rejectFleetPayment, returnFleetPayment } from "./actions";
import "./fleet-control.css";

export const dynamic = "force-dynamic";

type SearchParams = {
  section?: string;
  notice?: string;
  error?: string;
  request?: string;
};

export default async function FleetControlPage({ searchParams }: { searchParams?: SearchParams }) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login?next=/fleet-control");
  const companyId = requireCompanyId(authorization);
  const canEnter = hasPermission(authorization, "fleet_action_center", "access")
    || hasPermission(authorization, "fleet_vehicle_view", "access")
    || hasPermission(authorization, "payment_approvals", "access")
    || await hasActiveFleetMembership(companyId, authorization.userId);
  if (!canEnter) redirect("/unauthorized?page=fleet_action_center&reason=access");
  const data = await loadFleetControlData(companyId, authorization);

  return (
    <FleetControlDashboard
      approveAction={approveFleetPayment}
      data={data}
      initialRequestId={searchParams?.request}
      initialSection={searchParams?.section}
      message={searchParams?.error ? { type: "error", text: searchParams.error } : searchParams?.notice ? { type: "notice", text: searchParams.notice } : null}
      rejectAction={rejectFleetPayment}
      returnAction={returnFleetPayment}
    />
  );
}
