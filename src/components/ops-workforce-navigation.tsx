import { PendingLink } from "@/components/pending-link";
export function OpsWorkforceNavigation({ register = false }: { register?: boolean }) {
  return <nav className="workforce-lifecycle-tabs" aria-label="Workforce views">
    <PendingLink className={!register ? "active" : ""} href="/work-force-register">Onboarding requests</PendingLink>
    <PendingLink className={register ? "active" : ""} href="/work-force-register?section=register">Workforce register</PendingLink>
  </nav>;
}
