import { PendingLink } from "@/components/pending-link";
import { requirePagePermission, isCompanyOwner } from "@/lib/authorization";
export async function OpsWorkforceNavigation({ register = false, verification = false }: { register?: boolean; verification?: boolean }) {
  const auth = await requirePagePermission("delivery_associates", "access");
  return <nav className="workforce-lifecycle-tabs" aria-label="Workforce views">
    <PendingLink className={!register && !verification ? "active" : ""} href="/work-force-register">Onboarding requests</PendingLink>
    <PendingLink className={register && !verification ? "active" : ""} href="/work-force-register?section=register">Workforce register</PendingLink>
    {isCompanyOwner(auth) ? <PendingLink className={verification ? "active" : ""} href="/work-force-register?section=bgc">BGC follow-up · beta</PendingLink> : null}
  </nav>;
}
