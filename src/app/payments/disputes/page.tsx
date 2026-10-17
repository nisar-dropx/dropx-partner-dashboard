import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PayoutReviewDesk } from "@/components/payout-review-desk";
import { requirePagePermission } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { reviewPayout } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = {
  error?: string;
  notice?: string;
  q?: string;
  run?: string;
  status?: string;
  page?: string;
  size?: string;
  station?: string;
  category?: string;
  month?: string;
};

export default async function WorkforcePayoutDisputesPage({
  searchParams = {}
}: {
  searchParams?: SearchParams;
}) {
  // Same page on both sites: Ops Pulse uses its own grant, like Workforce Payouts.
  const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payout_disputes" : "workforce_payout_disputes";
  const authorization = await requirePagePermission(pageCode, "access");
  const message = searchParams.notice || searchParams.error;

  return (
    <AppShell active={pageCode === "ops_workforce_payout_disputes" ? "Payout Disputes" : "Disputes"} pageCode={pageCode}>
      <PageHead
        eyebrow="Payments"
        title="Payout Disputes"
        subtitle="Review associate payout concerns and record a final decision."
      />
      {message ? <p role={searchParams.error ? "alert" : "status"}>{message}</p> : null}
      <PayoutReviewDesk
        action={reviewPayout}
        auth={authorization}
        pageCode={pageCode}
        params={searchParams}
      />
    </AppShell>
  );
}
