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
  dashboard_portal: "DropX Dashboard",
  ops_portal: "OpsPulse",
  people_portal: "DropX People",
  platform_admin_portal: "Platform Admin",
  connect_portal: "DropX Connect",
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
          <p>This account is signed in, but access to the requested platform or page has not been assigned. You have not been redirected to another DropX platform.</p>
          <div className="message-panel warning"><Headphones size={16} aria-hidden="true" /><span>Contact HR or your platform administrator to request access. Share the platform name and your station or jurisdiction.</span></div>
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
