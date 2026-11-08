import { AppShell } from "@/components/app-shell";
import { PeopleFinancePayroll } from "@/components/people-finance-payroll";
import { paymentReleaseAccess } from "@/lib/payment-release-access";
export const dynamic = "force-dynamic";
export default async function Page() {
  await paymentReleaseAccess(false, true);
  return <AppShell active="People Payroll" pageCode="payment_process"><h1>People payroll</h1><PeopleFinancePayroll /></AppShell>;
}
