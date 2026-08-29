import { Headphones, LogOut, ShieldX } from "lucide-react";
import { signOut } from "@/app/login/actions";
import { SubmitButton } from "@/components/submit-button";

const pageNames: Record<string, string> = {
  capacity: "Capacity",
  capacity_overview: "Capacity Overview",
  capacity_associates: "Associate SPR",
  capacity_delivery: "Delivery Data",
  capacity_hiring: "Hiring Review",
  capacity_master: "Capacity Master",
  performance: "Performance",
  performance_master: "Performance Master",
  people_portal: "DropX People",
  ops_reports: "Reports",
  service_network: "Network Planning",
  service_network_master: "Network Planning Master"
};

export default function UnauthorizedPage({ searchParams }: { searchParams?: { page?: string } }) {
  const requestedPage = pageNames[String(searchParams?.page ?? "")] ?? "this page";
  return (
    <main className="login-page">
      <section className="login-panel">
        <img className="login-logo" src="/dropx-logo.png" alt="DropX" />
        <div className="login-copy">
          <span className="eyebrow"><ShieldX size={15} aria-hidden="true" /> Access not provided</span>
          <h1>You don&apos;t have access to {requestedPage}.</h1>
          <p>Your assigned role or location scope does not include this area. No other dashboard has been opened.</p>
          <div className="message-panel warning"><Headphones size={16} aria-hidden="true" /><span>Contact HR or DropX Operations Support to request access. Share the page name and your station or jurisdiction.</span></div>
        </div>
        <form action={signOut}>
          <SubmitButton className="button secondary" pendingText="Signing out">
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </SubmitButton>
        </form>
      </section>
    </main>
  );
}
