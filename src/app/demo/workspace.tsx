"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  CreditCard,
  FileText,
  HelpCircle,
  Menu,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Store,
  Truck,
  Users,
  X,
} from "lucide-react";
import type { NavItem } from "@/lib/app-navigation";
import {
  checklistTasks,
  csvText,
  demoDate,
  demoLink,
  demoLocations,
  demoMenus,
  recordGroup,
  seedRecords,
  type DemoMenu,
  type DemoRecord,
  type Kind,
  type Workspace,
} from "@/lib/ops-pulse/demo/catalog";
import s from "./workspace.module.css";
import { ProductionActivities } from "./production-activities";
import { AppShellFrame } from "@/components/app-shell-frame";
import { OpsPulseBrand } from "@/components/ops-pulse-brand";
import { OpsDesignNavigation } from "@/components/ops-design-navigation";
import { OpsMenuClose } from "@/components/ops-menu-close";

type Changes = Record<string, Partial<DemoRecord>>;
const storageKey = "opspulse-synthetic-demo-v2";
const statusClass = (status: string) =>
  /accepted|paid|complete|closed|resolved|reconciled|approved/i.test(status)
    ? s.good
    : /returned|variance|recovery|needs/i.test(status)
      ? s.warn
      : s.neutral;
const Icons: Record<string, typeof Activity> = {
  "Command Center": Activity,
  "Shift Attendance": Clock3,
  Rostering: Users,
  "Store Audits": ClipboardCheck,
  "Activities & Handover": ClipboardCheck,
  Performance: BarChart3,
  Capacity: BarChart3,
  Workforce: Users,
  Operations: Truck,
  "Business Docs": FileText,
  Payments: CreditCard,
  CPS: BarChart3,
  "CPU · Cost per unit": BarChart3,
  Fleet: Truck,
  "Team Ops": Users,
  Reports: FileText,
  Settings: Settings2,
  "Ops Masters": Settings2,
  "Users & Access": ShieldCheck,
  "Report Bot": Sparkles,
};
function Badge({ children }: { children: string }) {
  return (
    <span className={`${s.badge} ${statusClass(children)}`}>{children}</span>
  );
}
function saveFile(content: Blob, name: string) {
  const u = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}
function cells(menu: DemoMenu, row: DemoRecord) {
  const kind = menu.definition.kind;
  if (!row.tasks) return row.values;
  const done = row.tasks.filter(Boolean).length,
    pct = Math.round((done / row.tasks.length) * 100),
    submitted = ["Submitted", "Accepted"].includes(row.status);
  if (kind === "shift-report")
    return [
      row.values[0],
      row.values[1],
      submitted ? "Yes" : "No",
      `${pct}%`,
      row.status === "Accepted"
        ? "Accepted"
        : submitted
          ? "Awaiting acceptance"
          : "Not submitted",
    ];
  if (kind === "store-report")
    return [
      row.values[0],
      row.values[1],
      submitted ? "Yes" : "No",
      `${pct}%`,
      row.values[4],
    ];
  return [...row.values.slice(0, 3), `${done} / ${row.tasks.length}`];
}
export function DemoWorkspace({
  workspace,
  catalog,
}: {
  workspace: Workspace;
  catalog: NavItem[];
}) {
  const menus = useMemo(
    () =>
      ({ [workspace]: demoMenus(catalog) }) as Record<Workspace, DemoMenu[]>,
    [catalog, workspace],
  );
  const [screen, setScreen] = useState(""),
    [changes, setChanges] = useState<Changes>({}),
    [initialized, setInitialized] = useState(false);
  const [activityRoute, setActivityRoute] = useState("");
  const [mobile, setMobile] = useState(false),
    [navSearch, setNavSearch] = useState(""),
    [showSearch, setShowSearch] = useState(false),
    [expanded, setExpanded] = useState<string[]>([]);
  const [query, setQuery] = useState(""),
    [location, setLocation] = useState("All locations"),
    [status, setStatus] = useState("All statuses"),
    [sort, setSort] = useState("default");
  const [selected, setSelected] = useState<DemoRecord | null>(null),
    [notice, setNotice] = useState(""),
    [help, setHelp] = useState(false),
    [reset, setReset] = useState(false),
    [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Record<string, DemoRecord[]>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    function read() {
      const p = new URLSearchParams(window.location.search);
      const valid = workspace;
      const menu = valid
        ? menus[valid].find((m) => m.id === p.get("screen"))
        : null;
      setScreen(menu?.id || "");
      if (menu) {
        const route = new URL(menu.href, "https://demo.invalid");
        for (const key of ["view", "id", "from", "to", "tab"])
          if (p.has(key)) route.searchParams.set(key, p.get(key)!);
        setActivityRoute(route.pathname + route.search);
      }
      setSelected(null);
      setMobile(false);
    }
    read();
    try {
      const data = JSON.parse(
        sessionStorage.getItem(`${storageKey}:${workspace}`) || "{}",
      );
      if (data.version === 1) {
        setChanges(data.changes || {});
        setCreated(data.created || {});
      }
    } catch {
      /* unavailable storage starts a clean sample */
    }
    setInitialized(true);
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [menus, workspace]);
  useEffect(() => {
    if (!initialized) return;
    try {
      sessionStorage.setItem(
        `${storageKey}:${workspace}`,
        JSON.stringify({ version: 1, changes, created }),
      );
    } catch {
      /* memory-only demo remains usable */
    }
  }, [changes, created, initialized, workspace]);
  const menu = workspace
    ? menus[workspace].find((m) => m.id === screen) || menus[workspace][0]
    : null;
  function navigate(w: Workspace, m?: DemoMenu) {
    if (w !== workspace) return;
    setScreen(m?.id || "");
    setActivityRoute(m?.href || "");
    setQuery("");
    setLocation("All locations");
    setStatus("All statuses");
    setSelected(null);
    setCreating(false);
    setMobile(false);
    setNotice("");
    window.history.pushState({}, "", demoLink(w, m?.id));
    window.scrollTo(0, 0);
  }
  const currentKey =
    workspace && menu ? `${workspace}:${recordGroup(menu)}` : "";
  function recordsFor(m: DemoMenu) {
    return [
      ...seedRecords(m, workspace!),
      ...(created[`${workspace}:${recordGroup(m)}`] || []),
    ].map((row) => ({ ...row, ...changes[`${workspace}:${row.id}`] }));
  }
  const allRows = menu ? recordsFor(menu) : [];
  const rows = allRows
    .filter(
      (row) =>
        (location === "All locations" || row.location === location) &&
        (status === "All statuses" || row.status === status) &&
        `${row.location} ${row.values.join(" ")} ${row.notes}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "location"
        ? a.location.localeCompare(b.location)
        : sort === "status"
          ? a.status.localeCompare(b.status)
          : sort === "name"
            ? a.values[0].localeCompare(b.values[0])
            : 0,
    );
  function update(row: DemoRecord, patch: Partial<DemoRecord>, event: string) {
    const next = { ...patch, history: [...row.history, `Demo now — ${event}`] };
    setChanges((old) => ({
      ...old,
      [`${workspace}:${row.id}`]: { ...old[`${workspace}:${row.id}`], ...next },
    }));
    setSelected({ ...row, ...next });
    setNotice(`${event}. Saved in this demo session only.`);
  }
  function goHref(href: string) {
    const target = workspace && menus[workspace].find((m) => m.href === href);
    if (target) navigate(workspace!, target);
  }
  function exportCsv() {
    if (!menu) return;
    saveFile(
      new Blob(
        [
          "\uFEFF",
          csvText(
            ["Sample location", ...menu.definition.columns, "Status"],
            rows.map((row) => [row.location, ...cells(menu, row), row.status]),
          ),
        ],
        { type: "text/csv;charset=utf-8" },
      ),
      `OpsPulse-SAMPLE-${workspace}-${menu.label.replace(/\W+/g, "-")}.csv`,
    );
    setNotice("Sample CSV downloaded. It contains fictional records only.");
  }
  function resetSession() {
    sessionStorage.removeItem("opspulse-production-activities-demo-v1");
    window.dispatchEvent(new Event("opspulse-demo-reset"));
    setChanges({});
    setCreated({});
    setReset(false);
    setSelected(null);
    setNotice("Sample data reset for this workspace.");
  }
  const groupNames = workspace
    ? Array.from(new Set(menus[workspace].map((m) => m.group)))
    : [];
  const kind = menu?.definition.kind;
  const productionActivity =
    workspace === "q-commerce" &&
    Boolean(menu?.href.match(/^\/(si-handover|store-ops)(\?|\/report|$)/));
  function activityHref(target: string) {
    const route = new URL(target, "https://demo.invalid");
    const m = menus[workspace].find((m) => {
      const u = new URL(m.href, "https://demo.invalid");
      return (
        u.pathname === route.pathname &&
        (u.searchParams.get("tab") || "shift") ===
          (route.searchParams.get("tab") || "shift")
      );
    });
    if (!m) return demoLink(workspace, menu?.id);
    const out = new URL(demoLink(workspace, m.id), "https://demo.invalid");
    for (const [key, value] of route.searchParams)
      out.searchParams.set(key, value);
    return out.pathname + out.search;
  }
  function activityNavigate(target: string) {
    window.history.pushState({}, "", activityHref(target));
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.scrollTo(0, 0);
  }
  const commonProps = {
    menu: menu!,
    row: selected!,
    onClose: () => setSelected(null),
    update,
    onNotice: setNotice,
    workspace: workspace!,
  };
  if (!initialized)
    return <main className={s.loading}>Opening the OpsPulse demo…</main>;
  const navItems = catalog.map((item) => ({
    ...item,
    href: item.href
      ? demoLink(
          workspace,
          menus[workspace].find((m) => m.href === item.href)?.id,
        )
      : undefined,
    children: item.children?.map((child) => ({
      ...child,
      href: child.href
        ? demoLink(
            workspace,
            menus[workspace].find((m) => m.href === child.href)?.id,
          )
        : undefined,
    })),
  }));
  const topActions = (
    <>
      <span className="scope-label">3 sample locations</span>
      <span className={s.demoPill}>Demo operations lead</span>
    </>
  );
  return (
    <div
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          "a[href]",
        );
        if (
          !anchor?.closest(".sidebar") ||
          !anchor.getAttribute("href")?.startsWith(`/demo/`)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const target = new URL(anchor.href);
        navigate(
          workspace,
          menus[workspace].find(
            (m) => m.id === target.searchParams.get("screen"),
          ),
        );
      }}
    >
      <AppShellFrame
        key={menu?.id}
        opsDesignPreview
        trackEvents={false}
        pageTitle={menu?.label}
        desktopActions={topActions}
        mobileActions={<span className={s.demoPill}>Demo</span>}
        mobileBrand={<OpsPulseBrand />}
        sidebar={
          <aside className="sidebar">
            <OpsMenuClose />
            <div className="brand">
              <img className="brand-logo" src="/dropx-logo.png" alt="DropX" />
              <OpsPulseBrand />
            </div>
            <div className="ops-workspace-switcher">
              <strong>
                {workspace === "last-mile" ? "Last Mile" : "Dark Store"}
              </strong>
            </div>
            <OpsDesignNavigation
              items={navItems}
              active={menu?.label || "Command Center"}
            />
            <div className="sidebar-user ops-sidebar-user">
              <div className="avatar">D</div>
              <div>
                <strong>Demo operations lead</strong>
                <small>Sample profile</small>
              </div>
              <button className="link-button" onClick={() => setReset(true)}>
                Reset sample data
              </button>
            </div>
          </aside>
        }
      >
        <div className={s.demoBanner}>
          <span>
            <b>DEMO</b> Fictional sample data · changes stay in this browser
          </span>
          <button
            onClick={() => {
              if (!navigator.clipboard) {
                setNotice(
                  "Copy the address from your browser to share this demo.",
                );
                return;
              }
              navigator.clipboard
                .writeText(window.location.href)
                .then(() => setNotice("Demo link copied."))
                .catch(() =>
                  setNotice(
                    "Copy the address from your browser to share this demo.",
                  ),
                );
            }}
          >
            Copy demo link
          </button>
        </div>
        <div className={productionActivity ? undefined : s.content}>
          {!productionActivity && (
            <header className={s.pageHeader}>
              <div>
                <span className={s.eyebrow}>
                  {workspace === "q-commerce"
                    ? "Q-COMMERCE · DARK STORE"
                    : "LAST MILE"}{" "}
                  · SAMPLE WORKSPACE
                </span>
                <h1 ref={heading} tabIndex={-1}>
                  {menu?.label}
                </h1>
                <p>{menu?.definition.description}</p>
              </div>
              {kind !== "dashboard" ? (
                <button className={s.secondary} onClick={exportCsv}>
                  <ArrowDownToLine size={16} /> Export sample CSV
                </button>
              ) : null}
            </header>
          )}
          {notice ? (
            <div role="status" className={s.notice}>
              <CheckCircle2 size={17} />
              <span>{notice}</span>
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          ) : null}
          {productionActivity ? (
            <ProductionActivities
              route={activityRoute || menu!.href}
              href={activityHref}
              navigate={activityNavigate}
            />
          ) : kind === "dashboard" ? (
            <Dashboard
              workspace={workspace}
              go={goHref}
              menus={menus[workspace]}
              records={recordsFor}
            />
          ) : (
            <>
              <div className={s.metrics}>
                <Metric value={String(allRows.length)} label="Sample records" />
                <Metric
                  value={String(new Set(allRows.map((r) => r.location)).size)}
                  label={
                    workspace === "q-commerce"
                      ? "Stores represented"
                      : "Stations represented"
                  }
                />
                <Metric
                  value={String(
                    allRows.filter((r) =>
                      /pending|progress|review|open|variance|returned|response/i.test(
                        r.status,
                      ),
                    ).length,
                  )}
                  label="Need attention"
                  accent
                />
                <Metric
                  value={String(
                    allRows.filter((r) =>
                      /accepted|complete|closed|paid|resolved|reconciled/i.test(
                        r.status,
                      ),
                    ).length,
                  )}
                  label="Completed / settled"
                />
              </div>
              {kind === "cost" ? <CostOverview workspace={workspace} /> : null}
              {kind === "performance" ? <PerformanceChart /> : null}
              {kind === "report-bot" ? (
                <ReportBot location={demoLocations(workspace)[0]} />
              ) : null}
              {kind === "roster" ? (
                <div className={s.contextStrip}>
                  <Clock3 size={17} />
                  <strong>Week of 26 October</strong>
                  <span>Early 06–14 · Late 14–22 · Night 22–06</span>
                  <Badge>Sample week</Badge>
                </div>
              ) : null}
              {kind === "people" && menu?.href === "/users?section=roles" ? (
                <AccessDemo />
              ) : null}
              <section className={s.panel}>
                <div className={s.panelHead}>
                  <div>
                    <h2>
                      {kind === "master"
                        ? "Sample configuration"
                        : kind === "document"
                          ? "Document register"
                          : kind === "audit"
                            ? "Audit register"
                            : kind === "payment"
                              ? "Request register"
                              : kind === "checklist"
                                ? "Shift / store checklists"
                                : "Sample records"}
                    </h2>
                    <span>
                      {rows.length} of {allRows.length} records · open a row for
                      details
                    </span>
                  </div>
                  {["payment", "audit", "review"].includes(kind!) ? (
                    <button
                      className={s.primary}
                      onClick={() => setCreating(true)}
                    >
                      +{" "}
                      {kind === "payment"
                        ? "New sample request"
                        : kind === "audit"
                          ? "Schedule sample audit"
                          : "New sample review"}
                    </button>
                  ) : null}
                </div>
                <div className={s.filters}>
                  <label className={s.tableSearch}>
                    <Search size={16} />
                    <input
                      aria-label="Search sample records"
                      placeholder="Search records…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filter by sample location"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  >
                    <option>All locations</option>
                    {demoLocations(workspace).map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Filter by status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option>All statuses</option>
                    {Array.from(new Set(allRows.map((r) => r.status))).map(
                      (v) => (
                        <option key={v}>{v}</option>
                      ),
                    )}
                  </select>
                  <select
                    aria-label="Sort sample records"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    <option value="default">Default order</option>
                    <option value="location">Location A–Z</option>
                    <option value="name">Name / reference A–Z</option>
                    <option value="status">Status A–Z</option>
                  </select>
                </div>
                <div className={s.tableScroll}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>Location</th>
                        {menu!.definition.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                        <th>Status</th>
                        <th>
                          <span className={s.srOnly}>Action</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.location.split(" · ")[0]}</strong>
                            <small>{row.location.split(" · ")[1]}</small>
                          </td>
                          {cells(menu!, row).map((v, i) => (
                            <td key={i}>
                              {i === 0 ? <strong>{v}</strong> : v}
                            </td>
                          ))}
                          <td>
                            <Badge>{row.status}</Badge>
                          </td>
                          <td>
                            <button
                              className={s.rowButton}
                              onClick={() => setSelected(row)}
                            >
                              Open <ChevronRight size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={s.mobileRecords}>
                  {rows.map((row) => (
                    <article className={s.mobileRecord} key={row.id}>
                      <div>
                        <small>{row.location}</small>
                        <h3>{row.values[0]}</h3>
                        <Badge>{row.status}</Badge>
                      </div>
                      <dl>
                        {cells(menu!, row)
                          .slice(1)
                          .map((v, i) => (
                            <div key={i}>
                              <dt>{menu!.definition.columns[i + 1]}</dt>
                              <dd>{v}</dd>
                            </div>
                          ))}
                      </dl>
                      <button
                        className={s.rowButton}
                        onClick={() => setSelected(row)}
                      >
                        Open details <ArrowRight size={15} />
                      </button>
                    </article>
                  ))}
                </div>
                {!rows.length ? (
                  <div className={s.empty}>
                    <Search />
                    <h3>No sample records match</h3>
                    <button
                      className={s.secondary}
                      onClick={() => {
                        setQuery("");
                        setLocation("All locations");
                        setStatus("All statuses");
                      }}
                    >
                      Clear filters
                    </button>
                  </div>
                ) : null}
                <footer className={s.tableFooter}>
                  All records are fictional. Try actions here, then reset the
                  sample data.
                </footer>
              </section>
            </>
          )}
        </div>
      </AppShellFrame>
      {selected ? <RecordDialog {...commonProps} /> : null}
      {creating ? (
        <CreateDialog
          kind={kind!}
          locations={demoLocations(workspace)}
          onClose={() => setCreating(false)}
          onCreate={(row) => {
            setCreated((old) => ({
              ...old,
              [currentKey]: [...(old[currentKey] || []), row],
            }));
            setCreating(false);
            setNotice(
              "Sample record created. It is visible only in this browser session.",
            );
          }}
        />
      ) : null}
      {help ? (
        <Dialog title="A safe space to explore" onClose={() => setHelp(false)}>
          <div className={s.helpCopy}>
            <ShieldCheck size={32} />
            <p>
              Every name, location, amount and document in this workspace is
              fictional.
            </p>
            <ul>
              <li>Browse this workspace and their current menus.</li>
              <li>Open records, use filters and try sample workflows.</li>
              <li>
                Actions stay in this browser tab’s session; they never change
                production.
              </li>
              <li>
                Demo approvals, payroll, messages and integrations are
                simulations.
              </li>
            </ul>
            <p>Use fictional details only. Reset sample data to start again.</p>
          </div>
        </Dialog>
      ) : null}
      {reset ? (
        <Dialog title="Reset the demo?" onClose={() => setReset(false)}>
          <p>
            This clears your sample changes in this workspace. Live OpsPulse is
            unaffected.
          </p>
          <div className={s.dialogActions}>
            <button className={s.secondary} onClick={() => setReset(false)}>
              Keep exploring
            </button>
            <button className={s.primary} onClick={resetSession}>
              Reset sample data
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
function Brand() {
  return (
    <div className={s.brand}>
      <img src="/opspulse/mark.svg" alt="" width={30} height={30} />
      <div>
        <strong>
          Ops<span>Pulse</span>
        </strong>
        <small>OPERATIONS INTELLIGENCE</small>
      </div>
    </div>
  );
}
function Metric({
  value,
  label,
  accent = false,
}: {
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className={`${s.metric} ${accent ? s.metricAccent : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Dashboard({
  workspace,
  go,
  menus,
  records,
}: {
  workspace: Workspace;
  go: (href: string) => void;
  menus: DemoMenu[];
  records: (m: DemoMenu) => DemoRecord[];
}) {
  const ds = workspace === "q-commerce";
  const tasks = ds
    ? ([
        [
          "Shift operations",
          "Complete a sample handover",
          "/si-handover?view=start",
          ClipboardCheck,
        ],
        [
          "Store audits",
          "Respond to a sample finding",
          "/store-audits",
          ShieldCheck,
        ],
        [
          "Review desk",
          "Close an operational review",
          "/performance?view=reviews",
          BarChart3,
        ],
        [
          "Payment approvals",
          "Inspect the approval journey",
          "/payments/approvals",
          CreditCard,
        ],
      ] as const)
    : ([
        [
          "Shift attendance",
          "Review reporting and coverage",
          "/ops-pulse?view=manpower",
          Clock3,
        ],
        [
          "COD reconciliation",
          "Investigate a sample variance",
          "/cod/status",
          CreditCard,
        ],
        [
          "Fleet readiness",
          "Review vehicle service status",
          "/fleet?tab=action-center",
          Truck,
        ],
        [
          "Payment approvals",
          "Inspect the approval journey",
          "/payments/approvals",
          ClipboardCheck,
        ],
      ] as const);
  const pay = menus.find((m) => m.href === "/payments/approvals");
  const pending = pay
    ? records(pay).filter((r) => r.status === "Pending approval").length
    : 0;
  return (
    <>
      <div className={s.metrics}>
        <Metric
          label={ds ? "Units processed" : "Delivered shipments"}
          value="12,400"
        />
        <Metric label="On-time completion" value="98.6%" />
        <Metric
          label={ds ? "Cost per unit" : "Cost per shipment"}
          value="₹18.00"
        />
        <Metric
          label="Sample approvals pending"
          value={String(pending)}
          accent
        />
      </div>
      <div className={s.dashboardGrid}>
        <section className={s.panel}>
          <div className={s.panelHead}>
            <div>
              <h2>Try a daily workflow</h2>
              <span>Start with one of these connected examples</span>
            </div>
            <span className={s.demoPill}>Interactive</span>
          </div>
          <div className={s.actionGrid}>
            {tasks.map(([title, subtitle, href, Icon]) => (
              <button key={title} onClick={() => go(href)}>
                <Icon size={21} />
                <span>
                  <strong>{title}</strong>
                  <small>{subtitle}</small>
                </span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
        <section className={s.darkCard}>
          <span className={s.eyebrow}>THE OPERATION AT A GLANCE</span>
          <h2>
            {ds
              ? "From shift opening to the next handover."
              : "From station readiness to the final delivery."}
          </h2>
          <p>See the record. Understand the context. Follow the next action.</p>
          <button
            onClick={() =>
              go(
                ds
                  ? "/si-handover/report?tab=shift"
                  : "/performance?view=daily",
              )
            }
          >
            Explore the reporting view <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <section className={s.panel}>
        <div className={s.panelHead}>
          <div>
            <h2>{ds ? "Store" : "Station"} snapshot</h2>
            <span>Illustrative reporting week · 20–26 October 2026</span>
          </div>
          <button
            className={s.rowButton}
            onClick={() => go(ds ? "/cpu" : "/cps")}
          >
            Inspect unit costs <ArrowRight size={16} />
          </button>
        </div>
        <div className={s.locationGrid}>
          {demoLocations(workspace).map((l, i) => (
            <button
              key={l}
              onClick={() =>
                go(
                  ds
                    ? "/si-handover/report?tab=store"
                    : "/performance?view=daily",
                )
              }
            >
              <div>
                <strong>{l}</strong>
                <Badge>{i === 2 ? "Follow-up" : "On track"}</Badge>
              </div>
              <dl>
                <div>
                  <dt>Volume</dt>
                  <dd>{[4200, 4160, 4040][i].toLocaleString("en-IN")}</dd>
                </div>
                <div>
                  <dt>On time</dt>
                  <dd>{[99.1, 98.8, 97.9][i]}%</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>100%</dd>
                </div>
              </dl>
              <span>
                Open operational view <ArrowRight size={14} />
              </span>
            </button>
          ))}
        </div>
      </section>
      <div className={s.contextStrip}>
        <Sparkles size={18} />
        <span>
          <strong>Explore further:</strong> every menu has sample data, from
          operational reporting to master configuration.
        </span>
      </div>
    </>
  );
}
function PerformanceChart() {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <div>
          <h2>Consistency through the week</h2>
          <span>Illustrative on-time completion · target 98%</span>
        </div>
        <Badge>Sample trend</Badge>
      </div>
      <div className={s.chart}>
        {[98.2, 98.5, 98.1, 98.8, 99.0, 98.4, 98.6].map((v, i) => (
          <div key={i}>
            <b>{v}%</b>
            <span style={{ height: `${(v - 90) * 9}px` }} />
            <small>{20 + i} Oct</small>
          </div>
        ))}
      </div>
    </section>
  );
}
function CostOverview({ workspace }: { workspace: Workspace }) {
  return (
    <section className={s.costPanel}>
      <div>
        <span className={s.eyebrow}>TRANSPARENT SAMPLE CALCULATION</span>
        <h2>
          ₹2,23,200 ÷ 12,400 = <em>₹18.00</em>
        </h2>
        <p>
          Included operating cost ÷{" "}
          {workspace === "q-commerce"
            ? "processed units"
            : "delivered shipments"}
          .
        </p>
      </div>
      <div
        className={s.costBar}
        aria-label="People 69.4%, fleet or facility 16.7%, fuel or utilities 8.3%, other operations 5.6%"
      >
        <span style={{ flex: 12.5 }} />
        <span style={{ flex: 3 }} />
        <span style={{ flex: 1.5 }} />
        <span style={{ flex: 1 }} />
      </div>
      <small>
        People / associate pay · Fleet / facilities · Fuel / utilities · Other
        operations
      </small>
    </section>
  );
}
function ReportBot({ location }: { location: string }) {
  const [message, setMessage] = useState(
      "Opening readiness complete; inbound 1240 units; 1 open issue for next shift.",
    ),
    [parsed, setParsed] = useState(false);
  return (
    <section className={s.botPanel}>
      <div>
        <span className={s.eyebrow}>
          SCRIPTED SAMPLE · NO WHATSAPP CONNECTION
        </span>
        <h2>From team update to structured report</h2>
        <p>{location} · Example shift group</p>
      </div>
      <label>
        Try the sample message
        <textarea
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setParsed(false);
          }}
          maxLength={1000}
        />
      </label>
      <button
        className={s.primary}
        onClick={() => setParsed(true)}
        disabled={!message.trim()}
      >
        Preview sample parsing <ArrowRight size={16} />
      </button>
      {parsed ? (
        <div role="status" className={s.parsed}>
          <strong>Sample report prepared</strong>
          <dl>
            <div>
              <dt>Location</dt>
              <dd>{location}</dd>
            </div>
            <div>
              <dt>Message</dt>
              <dd>{message}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>Store lead confirms figures before submission</dd>
            </div>
          </dl>
          <small>
            This is a scripted preview; no message is sent or AI service called.
          </small>
        </div>
      ) : null}
    </section>
  );
}
function AccessDemo() {
  const [open, setOpen] = useState("");
  const [checked, setChecked] = useState([
    "Shift attendance",
    "Shift operations",
    "Store operations",
  ]);
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <div>
          <h2>Sample designation access</h2>
          <span>Expand a menu to see its permissions</span>
        </div>
        <Badge>Browser-only configuration</Badge>
      </div>
      {["Command Center", "Activities & Handover", "Payments"].map((g) => (
        <div className={s.accessGroup} key={g}>
          <button
            onClick={() => setOpen(open === g ? "" : g)}
            aria-expanded={open === g}
          >
            {open === g ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
            <strong>{g}</strong>
          </button>
          {open === g
            ? (g === "Activities & Handover"
                ? [
                    "Shift operations",
                    "Store operations",
                    "Shift report",
                    "Store report",
                  ]
                : g === "Payments"
                  ? ["Requests", "Approvals", "Payment report"]
                  : ["Command Center", "Shift attendance"]
              ).map((l) => (
                <label key={l}>
                  <input
                    type="checkbox"
                    checked={checked.includes(l)}
                    onChange={() =>
                      setChecked((old) =>
                        old.includes(l)
                          ? old.filter((x) => x !== l)
                          : [...old, l],
                      )
                    }
                  />
                  {l}
                  <small>View</small>
                </label>
              ))
            : null}
        </div>
      ))}
    </section>
  );
}
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const els = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
          ) || [],
        );
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={s.modalBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={s.dialog}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <span className={s.eyebrow}>OPSPULSE · SAMPLE RECORD</span>
            <h2>{title}</h2>
          </div>
          <button aria-label="Close details" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className={s.dialogBody}>{children}</div>
      </div>
    </div>
  );
}
function RecordDialog({
  menu,
  row,
  onClose,
  update,
  onNotice,
  workspace,
}: {
  menu: DemoMenu;
  row: DemoRecord;
  onClose: () => void;
  update: (r: DemoRecord, p: Partial<DemoRecord>, e: string) => void;
  onNotice: (s: string) => void;
  workspace: Workspace;
}) {
  const kind = menu.definition.kind,
    [note, setNote] = useState(row.notes),
    [values, setValues] = useState(row.values),
    [proof, setProof] = useState(false),
    [zoom, setZoom] = useState(1),
    [busy, setBusy] = useState(false);
  const completed = row.tasks?.filter(Boolean).length || 0,
    submitted = ["Submitted", "Accepted"].includes(row.status);
  const canEdit = ![
    "cost",
    "performance",
    "report",
    "document",
    "report-bot",
  ].includes(kind);
  function act(status: string, event: string) {
    update(row, { status, notes: note }, event);
  }
  async function exportSummary(format: "png" | "pdf") {
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1200;
      canvas.height = 1500;
      const c = canvas.getContext("2d")!;
      c.fillStyle = "#fff";
      c.fillRect(0, 0, 1200, 1500);
      c.fillStyle = "#172033";
      c.fillRect(0, 0, 1200, 155);
      c.fillStyle = "#ff8753";
      c.font = "bold 23px Arial";
      c.fillText("OpsPulse · FICTIONAL DEMO SUMMARY", 55, 55);
      c.fillStyle = "#fff";
      c.font = "bold 34px Arial";
      c.fillText(row.location, 55, 110);
      c.fillStyle = "#172033";
      c.font = "24px Arial";
      c.fillText(
        `${demoDate} · ${row.status} · ${completed}/${row.tasks?.length || 0} completed`,
        55,
        205,
      );
      c.font = "bold 28px Arial";
      c.fillText(menu.label, 55, 265);
      let y = 335;
      checklistTasks.forEach((t, i) => {
        c.font = "23px Arial";
        c.fillStyle = row.tasks?.[i] ? "#12764b" : "#b45309";
        c.fillText(`${row.tasks?.[i] ? "DONE" : "PENDING"}   ${t}`, 55, y);
        y += 66;
      });
      c.fillStyle = "#667085";
      c.font = "22px Arial";
      c.fillText(
        "Synthetic data for demonstration only. Not an operational report.",
        55,
        1430,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!blob) throw Error();
      if (format === "png") saveFile(blob, "OpsPulse-SAMPLE-summary.png");
      else {
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.create();
        const image = await pdf.embedPng(await blob.arrayBuffer());
        const page = pdf.addPage([600, 750]);
        page.drawImage(image, { x: 0, y: 0, width: 600, height: 750 });
        saveFile(
          new Blob([new Uint8Array(await pdf.save())], {
            type: "application/pdf",
          }),
          "OpsPulse-SAMPLE-summary.pdf",
        );
      }
      onNotice(`Sample ${format.toUpperCase()} downloaded.`);
    } catch {
      onNotice("Export is unavailable in this browser. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={menu.label} onClose={onClose}>
      <div className={s.recordSummary}>
        <div>
          <strong>{row.location}</strong>
          <span>{row.values[0]}</span>
        </div>
        <Badge>{row.status}</Badge>
      </div>
      <dl className={s.detailGrid}>
        {menu.definition.columns.map((col, i) => (
          <div key={col}>
            <dt>{col}</dt>
            <dd>{cells(menu, row)[i]}</dd>
          </div>
        ))}
      </dl>
      {row.tasks ? (
        <section className={s.checklist}>
          <div className={s.checklistHeader}>
            <h3>
              {menu.href.includes("store") ? "Store day" : "Shift"} checklist
            </h3>
            <strong>
              {completed}/{row.tasks.length} ·{" "}
              {Math.round((completed / row.tasks.length) * 100)}%
            </strong>
          </div>
          <progress value={completed} max={row.tasks.length} />
          {checklistTasks.map((task, i) => (
            <label key={task}>
              <input
                type="checkbox"
                checked={row.tasks![i]}
                disabled={submitted}
                onChange={() =>
                  update(
                    row,
                    { tasks: row.tasks!.map((v, n) => (n === i ? !v : v)) },
                    "Checklist answer updated",
                  )
                }
              />
              <span>{task}</span>
              {row.tasks![i] ? (
                <Check size={15} />
              ) : (
                <span className={s.pending}>Pending</span>
              )}
            </label>
          ))}
          <label className={s.noteLabel}>
            Handover / action note
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              disabled={submitted}
            />
          </label>
          <div className={s.dialogActions}>
            {!submitted ? (
              <>
                <button
                  className={s.secondary}
                  onClick={() => update(row, { notes: note }, "Draft saved")}
                >
                  Save sample draft
                </button>
                <button
                  className={s.primary}
                  disabled={completed !== row.tasks.length}
                  onClick={() => act("Submitted", "Sample checklist submitted")}
                >
                  Submit sample checklist
                </button>
              </>
            ) : row.status === "Submitted" ? (
              <button
                className={s.primary}
                onClick={() => act("Accepted", "Sample handover accepted")}
              >
                Accept sample handover
              </button>
            ) : (
              <span className={s.good}>Handover accepted</span>
            )}
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => void exportSummary("png")}
            >
              PNG
            </button>
            <button
              className={s.secondary}
              disabled={busy}
              onClick={() => void exportSummary("pdf")}
            >
              PDF
            </button>
          </div>
          <small>
            In live OpsPulse, the submitted summary can be shared to the store
            war room. Demo exports are marked as sample data.
          </small>
        </section>
      ) : null}
      {kind === "payment" ? (
        <section className={s.workflow}>
          <h3>Request journey</h3>
          <div className={s.steps}>
            {["Requested", "Approved", "Details added", "Paid"].map((v, i) => (
              <span
                key={v}
                className={
                  i <=
                  ["Approved", "Details added", "Paid"].indexOf(row.status) + 1
                    ? s.stepDone
                    : ""
                }
              >
                {i + 1}
                <small>{v}</small>
              </span>
            ))}
          </div>
          <p>{row.notes}</p>
          <label className={s.noteLabel}>
            Review / correction note
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <div className={s.dialogActions}>
            {row.status === "Pending approval" ? (
              <>
                <button
                  className={s.primary}
                  onClick={() => act("Approved", "Sample request approved")}
                >
                  Approve sample
                </button>
                <button
                  className={s.secondary}
                  disabled={!note.trim()}
                  onClick={() =>
                    act("Returned", "Sample request returned with note")
                  }
                >
                  Return with note
                </button>
              </>
            ) : row.status === "Returned" ? (
              <button
                className={s.primary}
                disabled={!note.trim()}
                onClick={() =>
                  act("Pending approval", "Sample request resubmitted")
                }
              >
                Resubmit sample
              </button>
            ) : row.status === "Approved" ? (
              <button
                className={s.primary}
                onClick={() =>
                  update(
                    row,
                    { status: "Details added", proof: true },
                    "Fictional payment details added",
                  )
                }
              >
                Add sample payment details
              </button>
            ) : row.status === "Details added" ? (
              <button
                className={s.primary}
                onClick={() =>
                  act("Paid", "Simulated payment recorded — no money moved")
                }
              >
                Simulate settlement
              </button>
            ) : (
              <Badge>Sample payment settled</Badge>
            )}
            <button className={s.secondary} onClick={() => setProof(!proof)}>
              View sample evidence
            </button>
          </div>
          <small>
            No bank account, approval or payment is created outside this demo.
          </small>
        </section>
      ) : null}
      {kind === "audit" ? (
        <section className={s.workflow}>
          <h3>
            {row.status === "Scheduled"
              ? "Scheduled inspection"
              : "Finding & corrective action"}
          </h3>
          <p>{row.notes}</p>
          <div className={s.contextStrip}>
            <Clock3 size={17} />
            <span>
              <strong>Action:</strong> Label the emergency equipment rack ·
              owner: sample store lead · due: 27 Oct, 10:00.
            </span>
          </div>
          <label className={s.noteLabel}>
            Action taken
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <div className={s.dialogActions}>
            <button
              className={s.secondary}
              onClick={() => {
                update(row, { proof: true }, "Sample evidence attached");
                setProof(true);
              }}
            >
              {row.proof
                ? "Sample evidence attached"
                : "Attach sample evidence"}
            </button>
            {row.status === "Scheduled" ? (
              <button
                className={s.primary}
                onClick={() =>
                  act("Awaiting response", "Sample inspection completed")
                }
              >
                Complete sample inspection
              </button>
            ) : row.status === "Awaiting response" ? (
              <button
                className={s.primary}
                disabled={!note.trim() || !row.proof}
                onClick={() =>
                  act("Review pending", "Corrective action submitted")
                }
              >
                Submit sample response
              </button>
            ) : row.status === "Review pending" ? (
              <button
                className={s.primary}
                onClick={() =>
                  act("Closed", "Sample corrective action verified")
                }
              >
                Verify & close sample
              </button>
            ) : (
              <Badge>Closed</Badge>
            )}
          </div>
        </section>
      ) : null}
      {kind === "document" || proof ? (
        <section className={s.documentPreview}>
          <div>
            <strong>Illustrative document</strong>
            <button
              aria-label="Zoom out document"
              onClick={() => setZoom((z) => Math.max(0.6, z - 0.2))}
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="Zoom in document"
              onClick={() => setZoom((z) => Math.min(2, z + 0.2))}
            >
              +
            </button>
            <button onClick={() => setZoom(1)}>Fit</button>
          </div>
          <div className={s.documentCanvas}>
            <article
              style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 100}%` }}
            >
              <ShieldCheck size={38} />
              <span className={s.eyebrow}>
                DEMO DOCUMENT · NOT VALID FOR COMPLIANCE
              </span>
              <h3>
                {kind === "document"
                  ? row.values[0]
                  : "Sample supporting evidence"}
              </h3>
              <p>{row.location}</p>
              <div className={s.docLine} />
              <p>
                This fictional document demonstrates in-window viewing. It
                contains no live documents, signatures or personal information.
              </p>
              <p>
                Reference: SAMPLE-ONLY
                <br />
                Prepared: {demoDate}
              </p>
              <strong className={s.sampleStamp}>SAMPLE</strong>
            </article>
          </div>
        </section>
      ) : null}
      {!row.tasks && !["payment", "audit", "document"].includes(kind) ? (
        <section className={s.workflow}>
          <h3>
            {kind === "master"
              ? "Configuration"
              : kind === "loss"
                ? "Decision & recovery context"
                : "Record context"}
          </h3>
          <p>{row.notes}</p>
          {canEdit ? (
            <>
              <div className={s.editGrid}>
                {menu.definition.columns.map((col, i) => (
                  <label key={col}>
                    {col}
                    <input
                      value={values[i] || ""}
                      maxLength={150}
                      onChange={(e) =>
                        setValues((old) =>
                          old.map((v, n) => (n === i ? e.target.value : v)),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
              <label className={s.noteLabel}>
                Remark
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1000}
                />
              </label>
              <div className={s.dialogActions}>
                <button
                  className={s.primary}
                  onClick={() =>
                    update(
                      row,
                      {
                        values,
                        notes: note,
                        status:
                          kind === "review"
                            ? "Resolved"
                            : kind === "cod"
                              ? "Verified"
                              : kind === "loss"
                                ? "Plan recorded"
                                : kind === "roster"
                                  ? "Approved"
                                  : "Updated",
                      },
                      menu.definition.action || "Sample updated",
                    )
                  }
                >
                  {menu.definition.action || "Save sample"}
                </button>
              </div>
              {kind === "loss" ? (
                <small>
                  This records a demo plan only. It does not deduct salary or
                  create a payroll entry.
                </small>
              ) : null}
            </>
          ) : (
            <div className={s.contextStrip}>
              <FileText size={18} />
              <span>
                Inspect this sample record and download its table using Export
                sample CSV.
              </span>
            </div>
          )}
        </section>
      ) : null}
      <details className={s.history}>
        <summary>
          Activity history <span>{row.history.length}</span>
        </summary>
        <ol>
          {row.history.map((event, i) => (
            <li key={i}>{event}</li>
          ))}
        </ol>
      </details>
    </Dialog>
  );
}
function CreateDialog({
  kind,
  locations,
  onClose,
  onCreate,
}: {
  kind: Kind;
  locations: string[];
  onClose: () => void;
  onCreate: (r: DemoRecord) => void;
}) {
  const [location, setLocation] = useState(locations[0]),
    [title, setTitle] = useState(
      kind === "payment"
        ? "Adhoc support"
        : kind === "audit"
          ? "Store readiness audit"
          : "Operational follow-up",
    ),
    [owner, setOwner] = useState("Sample operations lead"),
    [amount, setAmount] = useState("1200"),
    [note, setNote] = useState("");
  return (
    <Dialog
      title={
        kind === "payment"
          ? "New sample request"
          : kind === "audit"
            ? "Schedule sample audit"
            : "New sample review"
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const ref = `DEMO-${Date.now().toString().slice(-6)}`;
          onCreate({
            id: ref,
            location,
            values:
              kind === "payment"
                ? [
                    ref,
                    title,
                    owner,
                    `₹${Number(amount).toLocaleString("en-IN")}`,
                  ]
                : kind === "audit"
                  ? [title, owner, "27 Oct · 10:00", "Not started", "0"]
                  : [title, owner, "Sample metric", "27 Oct · 17:00"],
            status:
              kind === "payment"
                ? "Pending approval"
                : kind === "audit"
                  ? "Scheduled"
                  : "Open",
            notes: note || "New fictional sample record.",
            history: ["Demo now — Created in browser session"],
          });
        }}
      >
        <div className={s.editGrid}>
          <label>
            Sample location
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            >
              {locations.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            {kind === "payment" ? "Payment head" : "Title"}
            <input
              value={title}
              required
              maxLength={150}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Sample owner
            <input
              value={owner}
              required
              maxLength={100}
              onChange={(e) => setOwner(e.target.value)}
            />
          </label>
          {kind === "payment" ? (
            <label>
              Sample amount (₹)
              <input
                type="number"
                min="1"
                max="1000000"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          ) : null}
        </div>
        <label className={s.noteLabel}>
          Context / purpose
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
          />
        </label>
        <small>
          Use fictional details only. This does not send notifications.
        </small>
        <div className={s.dialogActions}>
          <button type="button" className={s.secondary} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={s.primary}>
            Create sample
          </button>
        </div>
      </form>
    </Dialog>
  );
}
