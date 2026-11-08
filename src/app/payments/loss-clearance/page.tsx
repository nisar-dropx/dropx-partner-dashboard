import { AppShell } from "@/components/app-shell";
import { PaymentReleaseReviewPanel } from "@/components/payment-release-review";
import { paymentReleaseAccess } from "@/lib/payment-release-access";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const { auth } = await paymentReleaseAccess();
  return <AppShell active="Payment release review"><h1>Payment release review</h1><PaymentReleaseReviewPanel initialMonth={searchParams.month} initialStation={searchParams.station} initialScope={searchParams.scope} /></AppShell>;
}
