import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PayoutReviewDesk } from "@/components/payout-review-desk";
import { requirePagePermission } from "@/lib/authorization";
import { reviewPayout } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = {
  error?: string;
  notice?: string;
  q?: string;
  run?: string;
  status?: string;
};

export default async function WorkforcePayoutDisputesPage({
  searchParams = {}
}: {
  searchParams?: SearchParams;
}) {
  const authorization = await requirePagePermission("workforce_payout_disputes", "access");
  const message = searchParams.notice || searchParams.error;

  return (
    <AppShell active="Disputes" pageCode="workforce_payout_disputes">
      <PageHead
        eyebrow="Payments"
        title="Payout Disputes"
        subtitle="Review associate payout concerns and record a final decision."
      />
      {message ? <p role={searchParams.error ? "alert" : "status"}>{message}</p> : null}
      <PayoutReviewDesk
        action={reviewPayout}
        auth={authorization}
        params={searchParams}
      />
    </AppShell>
  );
}
