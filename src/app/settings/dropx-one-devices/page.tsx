import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { deviceGroups, loadBoundDevices, type DeviceGroup } from "@/lib/dropx-one-devices";
import { resetDropxOneDevice } from "./actions";
import styles from "./devices.module.css";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const DEVICES_PATH = "/settings/dropx-one-devices";

function devicesHref(params: { search?: string; group?: string; page?: number }) {
  const query = new URLSearchParams();
  if (params.group) query.set("group", params.group);
  if (params.search) query.set("search", params.search);
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const text = query.toString();
  return text ? `${DEVICES_PATH}?${text}` : DEVICES_PATH;
}

export default async function DropxOneDevicesPage({
  searchParams = {}
}: {
  searchParams?: { search?: string; group?: string; page?: string; notice?: string; error?: string };
}) {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canReset = !authorization.readOnly && Boolean(authorization.permissions.app_settings?.canEdit);

  const searchValue = String(searchParams.search ?? "").trim();
  const searchTerm = searchValue.toLowerCase();
  const group = deviceGroups.some((item) => item.value === searchParams.group) ? searchParams.group as DeviceGroup : undefined;
  const requestedPage = Math.max(1, Number.parseInt(String(searchParams.page ?? "1"), 10) || 1);
  const notice = String(searchParams.notice ?? "").trim();
  const errorNotice = String(searchParams.error ?? "").trim();

  const { people, error: loadError } = await loadBoundDevices(companyId);
  // The search runs across every group, so an ID is found whichever tab is open.
  const matching = searchTerm
    ? people.filter((person) => `${person.name} ${person.codes.join(" ")} ${person.mobile} ${person.mobile.replace(/\D/g, "")} ${person.phone} ${person.roles.join(" ")}`.toLowerCase().includes(searchTerm))
    : people;
  const filtered = group ? matching.filter((person) => person.groups.includes(group)) : matching;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const returnTo = devicesHref({ search: searchValue || undefined, group, page });
  const tabs = [
    { value: undefined as DeviceGroup | undefined, label: "Everyone", count: matching.length },
    ...deviceGroups.map((item) => ({ value: item.value as DeviceGroup | undefined, label: item.label, count: matching.filter((person) => person.groups.includes(item.value)).length }))
  ];

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Configuration"
        title="DropX One devices"
        subtitle="Each person can use DropX One on one phone only. If someone changes or loses their phone, reset their device here; their old phone is signed out and their next sign-in binds the new one."
        action={<a className="button secondary" href="/settings">Back</a>}
      />

      {errorNotice || loadError ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Action required</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{errorNotice || loadError}</p>
          </div>
        </section>
      ) : null}
      {notice && !errorNotice ? (
        <section className="panel message-panel success">
          <div className="panel-body">
            <strong>Completed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{notice}</p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Bound phones</h2>
            <p className="subtle">
              {filtered.length} {filtered.length === 1 ? "person" : "people"}
              {searchTerm ? ` matching “${searchValue}”` : ""} — workforce, delivery associates, contractors and employees.
            </p>
          </div>
        </div>

        <div className={styles.toolbar}>
          <nav className={`tabs ${styles.tabs}`} aria-label="Filter by type">
            {tabs.map((tab) => (
              <PendingLink
                className={`tab${tab.value === group ? " active" : ""}`}
                href={devicesHref({ search: searchValue || undefined, group: tab.value })}
                key={tab.label}
              >
                {tab.label}<span className={styles.tabCount}>{tab.count}</span>
              </PendingLink>
            ))}
          </nav>
          <form action={DEVICES_PATH} className={styles.search} method="get">
            {group ? <input name="group" type="hidden" value={group} /> : null}
            <input
              aria-label="Search people"
              className="field"
              defaultValue={searchValue}
              name="search"
              placeholder="Search employee ID, name, mobile or phone model"
            />
            <button className="button secondary" type="submit">Search</button>
            {searchTerm ? <a className="button secondary" href={devicesHref({ group })}>Clear</a> : null}
          </form>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Employee ID</th>
                <th>Phone</th>
                <th>Bound since</th>
                <th>Last sign-in</th>
                <th>Reset device</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length ? pageRows.map((person) => (
                <tr key={person.bindingId}>
                  <td>
                    <div className={styles.person}>
                      <strong>{person.name}</strong>
                      <span className={styles.meta}>{[person.mobile, ...person.roles].filter(Boolean).join(" · ")}</span>
                    </div>
                  </td>
                  <td>
                    {person.codes.length
                      ? person.codes.map((code) => <span className={styles.code} key={code}>{code}</span>)
                      : <span className={styles.noCode}>No ID</span>}
                  </td>
                  <td>{person.phone}</td>
                  <td>{formatDashboardDateTime(person.boundSince)}</td>
                  <td>{formatDashboardDateTime(person.lastSignIn)}</td>
                  <td>
                    {canReset ? (
                      <form action={resetDropxOneDevice} className={styles.reset}>
                        <input name="binding_id" type="hidden" value={person.bindingId} />
                        <input name="return_to" type="hidden" value={returnTo} />
                        <input
                          aria-label={`Reason for resetting ${person.name}'s device`}
                          className="field"
                          maxLength={300}
                          name="reason"
                          placeholder="Reason (e.g. new phone)"
                        />
                        <SubmitButton
                          className="button secondary"
                          confirmDescription="Their current phone is signed out of DropX One straight away. The next phone they sign in on becomes their device."
                          confirmMessage={`Reset the DropX One device for ${person.name}${person.codes.length ? ` (${person.codes.join(" / ")})` : ""}?`}
                          confirmSubmitText="Reset device"
                          confirmTitle="Reset device"
                          pendingText="Resetting"
                        >
                          Reset
                        </SubmitButton>
                      </form>
                    ) : <span className="subtle">View only</span>}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="empty-cell" colSpan={6}>
                    {searchTerm || group
                      ? "No bound phones match this search."
                      : "No phones are bound yet. A phone is bound the first time someone signs in on the updated DropX One app."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > PAGE_SIZE ? (
          <div className={styles.footer}>
            <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
            <span className="pagination">
              {page > 1 ? <PendingLink className="pager-button" href={devicesHref({ search: searchValue || undefined, group, page: page - 1 })}>Prev</PendingLink> : null}
              <span>Page {page} of {pageCount}</span>
              {page < pageCount ? <PendingLink className="pager-button" href={devicesHref({ search: searchValue || undefined, group, page: page + 1 })}>Next</PendingLink> : null}
            </span>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
