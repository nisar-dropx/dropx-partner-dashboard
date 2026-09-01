import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { getAuthorization, isCompanyOwner } from "@/lib/authorization";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function WorkforceTransferPage() {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  if (!isCompanyOwner(authorization)) redirect("/unauthorized?page=people_all&action=edit");

  return (
    <AppShell active="All People" pageCode="people_all">
      <PageHead
        eyebrow="Owner Tool"
        title="Workforce category cleanup"
        subtitle="Keep canonical Workforce records and permanently remove matching Delivery Executive duplicates."
      />
      <section className="panel" style={{ maxWidth: 760 }}>
        <div className="panel-body">
          <form action="/people/workforce/transfer/execute" method="post">
            <input name="operation" type="hidden" value="remove_delivery_executive_duplicates" />
            <input name="apply" type="hidden" value="true" />
            <label>
              DropX IDs
              <textarea className="field" name="ids" placeholder="Enter one or more DropX IDs" required rows={4} />
            </label>
            <div className="form-actions" style={{ marginTop: 18 }}>
              <button className="button" type="submit">Confirm cleanup</button>
            </div>
          </form>
        </div>
      </section>
    </AppShell>
  );
}
