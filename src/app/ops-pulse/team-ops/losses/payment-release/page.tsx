import { PaymentReleaseReviewPanel } from "@/components/payment-release-review";
import { paymentReleaseAccess } from "@/lib/payment-release-access";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  await paymentReleaseAccess();
  return <><h1>Payment release review</h1><PaymentReleaseReviewPanel initialMonth={searchParams.month} initialStation={searchParams.station} initialScope={searchParams.scope} /></>;
}
