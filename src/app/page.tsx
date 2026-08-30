import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { firstAllowedFinanceHref, hasFinancePortalAccess } from "@/lib/finance/navigation";
import { isFinanceHostName } from "@/lib/finance/surface";
import { getAuthorization } from "@/lib/authorization";
import { firstAllowedPeopleHref, hasPeoplePortalAccess } from "@/lib/people/navigation";
import { isPeopleHostName } from "@/lib/people/surface";
import { capabilityOwnership, productDefinitions } from "@/lib/product-ownership";

export default async function PlatformControlPage() {
  const host = (
    headers().get("x-forwarded-host") ??
    headers().get("host") ??
    ""
  ).split(":")[0].toLowerCase();
  if (host === "admin-panel.dropxlogistics.com") redirect("/platform-admin");
  if (host === "connect.dropxlogistics.com") redirect("/connect");

  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (isPeopleHostName(host)) {
    if (!hasPeoplePortalAccess(authorization)) redirect("/unauthorized?page=people_portal&reason=access");
    redirect(firstAllowedPeopleHref(authorization) ?? "/unauthorized?page=people_portal&reason=access");
  }
  if (isFinanceHostName(host)) {
    if (!hasFinancePortalAccess(authorization)) redirect("/unauthorized?page=finance_portal&reason=access");
    redirect(firstAllowedFinanceHref(authorization) ?? "/unauthorized?page=finance_portal&reason=access");
  }
  if (!authorization.isMasterOwner) {
    redirect("/unauthorized?page=dashboard_portal&reason=super_admin_only");
  }

  return (
    <AppShell active="Platform Control" pageCode="dashboard">
      <PageHead
        eyebrow="Super Admin"
        title="DropX platform control"
        subtitle="Assign Product Owners, open each independent portal, and manage only cross-product technical controls here. Daily business masters are owned inside their respective products."
        action={<Link className="button" href="https://admin-panel.dropxlogistics.com/platform-admin">Open Masters</Link>}
      />

      <section className="grid three">
        {productDefinitions.map((product) => (
          <article className="panel" key={product.code}>
            <div className="panel-body stacked">
              <span className="eyebrow">{product.code === "tech" ? "Super Admin only" : "Product-owned"}</span>
              <h2>{product.name}</h2>
              <p className="subtle">Open the dedicated frontend. Its Product Owner controls users, roles, and product-specific masters.</p>
              <Link className="button secondary" href={product.portalUrl}>Open {product.name}</Link>
            </div>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Ownership boundaries</h2><p className="subtle">One writer for each master; other products consume it without maintaining duplicate copies.</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Capability</th><th>Owner</th><th>Consumers</th></tr></thead>
            <tbody>
              {capabilityOwnership.map((item) => {
                const owner = productDefinitions.find((product) => product.code === item.owner);
                return <tr key={item.capability}><td><strong>{item.capability}</strong></td><td>{owner?.name ?? item.owner}</td><td>{item.consumer}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
