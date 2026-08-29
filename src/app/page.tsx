import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { firstAllowedHref } from "@/lib/app-navigation";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { firstAllowedPeopleHref, hasPeoplePortalAccess } from "@/lib/people/navigation";
import { isPeopleHostName } from "@/lib/people/surface";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

const dashboardMetrics = [
  { label: "MTD payable", value: "Rs 0", foot: "Calculated after report import and mapping" },
  { label: "Payroll blockers", value: "0", foot: "Unmapped IDs, rates, holds, corrections" },
  { label: "Mapping coverage", value: "0%", foot: "Provider report rows resolved" },
  { label: "DAs on pay", value: "0", foot: "Based on active earning rows" }
];

const processStages = [
  { step: "1", title: "DA onboarding", owner: "Manager", state: "No pending data" },
  { step: "2", title: "Provider ID mapping", owner: "Manager", state: "No pending data" },
  { step: "3", title: "Rate approval", owner: "Admin", state: "No pending data" },
  { step: "4", title: "Daily report import", owner: "Admin", state: "No imports" },
  { step: "5", title: "Earnings review", owner: "Admin", state: "No payroll data" }
];

export default async function DashboardPage() {
  const host = headers().get("x-forwarded-host")?.split(":")[0].toLowerCase() ?? headers().get("host")?.split(":")[0].toLowerCase() ?? "";
  if (host === "admin-panel.dropxlogistics.com") redirect("/platform-admin");
  if (host === "connect.dropxlogistics.com") redirect("/connect");
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (isPeopleHostName(host)) {
    if (!hasPeoplePortalAccess(authorization)) redirect("/unauthorized?page=people_portal&reason=access");
    redirect(firstAllowedPeopleHref(authorization) ?? "/unauthorized?page=people_portal&reason=access");
  }
  if (!hasPermission(authorization, "dashboard", "access")) {
    redirect(firstAllowedHref(authorization) ?? "/unauthorized?page=dashboard&action=access");
  }

  return (
    <AppShell active="Command Center">
      <PageHead
        eyebrow="Daily control room"
        title="DropX DA operations command center"
        subtitle="One flow for blue-collar delivery associates: onboard DA, map Provider ID, import report, calculate earnings, clear blockers, close payroll."
        action={<button className="button">Start daily import</button>}
      />

      <section className="grid metrics">
        {dashboardMetrics.map((metric) => (
          <article className="panel metric" key={metric.label}>
            <div className="metric-label">{metric.label}</div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-foot">{metric.foot}</div>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Operating process</h2>
            <p className="subtle">This is the source-of-truth chain every imported row must pass before salary export.</p>
          </div>
        </div>
        <div className="process-strip">
          {processStages.map((stage) => (
            <div className="process-card" key={stage.step}>
              <div className="process-step">{stage.step}</div>
              <h3>{stage.title}</h3>
              <p>{stage.owner}</p>
              <strong>{stage.state}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="grid two">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Today&apos;s work queue</h2>
              <p className="subtle">Only items that block mapping, payout, or payroll close appear here.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Priority</th>
                  <th>Work item</th>
                  <th>Owner</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>CTA</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={6} className="empty-cell">No work queue items.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <aside className="panel">
          <div className="panel-head">
            <h2>Payroll blockers</h2>
          </div>
          <div className="panel-body stacked">
            <p className="subtle">No payroll blockers.</p>
          </div>
        </aside>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Latest provider imports</h2>
            <p className="subtle">Amazon is ready from sample format. Flipkart and Meesho parsers activate after sample files are loaded.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Provider</th>
                <th>Report date</th>
                <th>ID column</th>
                <th>Rows</th>
                <th>Mapped</th>
                <th>Exceptions</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={8} className="empty-cell">No provider imports found.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
