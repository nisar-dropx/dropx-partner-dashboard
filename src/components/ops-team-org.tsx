"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { TeamOrgCoveragePerson, TeamOrgNode, TeamOrgView } from "@/lib/ops-pulse/team-org-core";

// Past this many people, opening every branch at once makes the chart too wide to read and slow to paint.
const EXPAND_ALL_LIMIT = 400;
const DIRECTORY_PAGE_SIZE = 100;

type Graph = {
  byId: Map<string, TeamOrgNode>;
  children: Map<string, TeamOrgNode[]>;
  roots: TeamOrgNode[];
  unmapped: TeamOrgNode[];
};

function buildGraph(nodes: TeamOrgNode[]): Graph {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, TeamOrgNode[]>();
  for (const node of nodes) {
    if (!node.managerId) continue;
    const list = children.get(node.managerId);
    if (list) list.push(node); else children.set(node.managerId, [node]);
  }
  const roots = nodes.filter((node) => !node.managerId && (children.has(node.id) || node.isTopLevel || node.relation === "self"));
  const charted = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const node = queue.pop()!;
    if (charted.has(node.id)) continue;
    charted.add(node.id);
    queue.push(...(children.get(node.id) ?? []));
  }
  return { byId, children, roots, unmapped: nodes.filter((node) => !charted.has(node.id)) };
}

function lineAbove(graph: Graph, id: string) {
  const chain: TeamOrgNode[] = [];
  const seen = new Set([id]);
  let cursor = graph.byId.get(id)?.managerId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = graph.byId.get(cursor);
    if (!node) break;
    chain.push(node);
    cursor = node.managerId;
  }
  return chain.reverse();
}

function reportsOf(graph: Graph, id: string, allLevels: boolean) {
  const rows: { node: TeamOrgNode; depth: number }[] = [];
  const seen = new Set([id]);
  const walk = (parentId: string, depth: number) => {
    for (const node of graph.children.get(parentId) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push({ node, depth });
      if (allLevels) walk(node.id, depth + 1);
    }
  };
  walk(id, 0);
  return rows;
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

function Avatar({ name }: { name: string }) {
  return <span className="team-org-avatar" aria-hidden="true">{initials(name)}</span>;
}

function matches(node: TeamOrgNode, term: string) {
  return [node.name, node.code, node.title, node.department, node.location].some((value) => value?.toLowerCase().includes(term));
}

function PersonCard({ node, reports, expanded, onToggle, onFocus }: { node: TeamOrgNode; reports: number; expanded: boolean; onToggle: () => void; onFocus: () => void }) {
  return <article className={`team-org-person ${node.relation}`} data-team-org-self={node.relation === "self" || undefined}>
    <Avatar name={node.name} />
    <div className="team-org-person-copy">
      <button type="button" title={`Show ${node.name} in the directory`} onClick={onFocus}>{node.name}</button>
      <span title={node.title}>{node.title}</span>
      <small title={node.location ?? "Location not assigned"}>{node.location ?? "Location not assigned"}</small>
    </div>
    {node.relation === "self" ? <em>You</em> : null}
    {reports ? <button
      className="team-org-expand"
      type="button"
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${reports} direct report${reports === 1 ? "" : "s"} of ${node.name}`}
      onClick={onToggle}
    ><span aria-hidden="true">{expanded ? "−" : "+"}</span>{reports}</button> : null}
  </article>;
}

function Branch({ node, graph, expanded, onToggle, onFocus }: { node: TeamOrgNode; graph: Graph; expanded: Set<string>; onToggle: (id: string) => void; onFocus: (id: string) => void }) {
  const children = graph.children.get(node.id) ?? [];
  const open = expanded.has(node.id);
  return <li className="team-org-node">
    <PersonCard node={node} reports={children.length} expanded={open} onToggle={() => onToggle(node.id)} onFocus={() => onFocus(node.id)} />
    {children.length && open ? <ul>{children.map((child) => <Branch key={child.id} node={child} graph={graph} expanded={expanded} onToggle={onToggle} onFocus={onFocus} />)}</ul> : null}
  </li>;
}

function Chart({ view, graph, companyName, onFocus }: { view: TeamOrgView; graph: Graph; companyName: string; onFocus: (id: string) => void }) {
  // Open on the viewer's own reporting line; a station login opens on the line above its people.
  const defaultExpanded = useMemo(() => {
    const ids = new Set<string>();
    for (const selfId of view.selfIds) {
      ids.add(selfId);
      for (const node of lineAbove(graph, selfId)) ids.add(node.id);
    }
    if (view.mode === "location") {
      const openAll = view.nodes.length <= EXPAND_ALL_LIMIT;
      for (const node of view.nodes) if (openAll || node.relation === "upline") ids.add(node.id);
    }
    return ids;
  }, [graph, view]);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    const self = scroller?.querySelector<HTMLElement>("[data-team-org-self]");
    if (!scroller || !self) return;
    const offset = self.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    scroller.scrollLeft += offset - (scroller.clientWidth - self.offsetWidth) / 2;
  }, []);

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const canExpandAll = view.nodes.length <= EXPAND_ALL_LIMIT;

  return <section className="panel team-org-panel">
    <div className="team-org-panel-head">
      <div>
        <h2>Reporting map</h2>
        <p>Use + to open a manager&apos;s direct reports. Select a name to see that person&apos;s team in the list below.</p>
      </div>
      <div className="team-org-actions">
        <button className="button secondary" type="button" disabled={!canExpandAll} title={canExpandAll ? undefined : "Too many people to open at once. Expand the teams you need."} onClick={() => setExpanded(new Set(graph.children.keys()))}>Expand all</button>
        <button className="button secondary" type="button" disabled={!expanded.size} onClick={() => setExpanded(new Set())}>Collapse all</button>
        <button className="button secondary" type="button" onClick={() => setExpanded(defaultExpanded)}>Reset view</button>
      </div>
    </div>
    <div className="team-org-scroll" ref={scrollRef}>
      <div className="team-org-chart">
        <article className="team-org-company"><span>DX</span><div><strong>{companyName}</strong><small>{view.mode === "company" ? "All locations" : "Your reporting scope"}</small></div></article>
        {graph.roots.length
          ? <ul className="team-org-roots">{graph.roots.map((root) => <Branch key={root.id} node={root} graph={graph} expanded={expanded} onToggle={toggle} onFocus={onFocus} />)}</ul>
          : <p className="team-org-empty">No reporting line is mapped for these people yet.</p>}
      </div>
    </div>
    {graph.unmapped.length ? <details className="team-org-unmapped">
      <summary><span><strong>{graph.unmapped.length} {graph.unmapped.length === 1 ? "person has" : "people have"} no reporting manager</strong><small>They stay outside the map until People assigns their reporting line.</small></span><em>View</em></summary>
      <div className="team-org-unmapped-grid">{graph.unmapped.map((node) => <article key={node.id}>
        <Avatar name={node.name} />
        <div><strong>{node.name}</strong><span>{node.title}</span><small>{node.location ?? "Location not assigned"}</small></div>
      </article>)}</div>
    </details> : null}
  </section>;
}

function Names({ people }: { people: TeamOrgCoveragePerson[] }) {
  if (!people.length) return <span className="team-org-muted">Not mapped</span>;
  return <>{people.map((person, index) => <span className="team-org-name" key={`${person.name}:${index}`} title={person.title}>{person.name}</span>)}</>;
}

function Coverage({ view }: { view: TeamOrgView }) {
  if (!view.coverage.length) return null;
  const table = <div className="table-wrap team-org-table-wrap">
    <table className="team-org-table">
      <thead><tr><th>Location</th><th>People</th><th>Station lead</th><th>Cluster manager</th><th>Area operations manager</th></tr></thead>
      <tbody>{view.coverage.map((row) => <tr key={row.location}>
        <td><strong>{row.location}</strong></td>
        <td>{row.people}</td>
        <td><Names people={row.leads} /></td>
        <td><Names people={row.clusterManagers} /></td>
        <td><Names people={row.areaManagers} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
  const heading = <div><h2>Locations and clusters</h2><p>Who each location&apos;s people report up to.</p></div>;
  // The whole-company list is long, so it starts closed there.
  return view.mode === "company"
    ? <details className="panel team-org-panel team-org-coverage"><summary className="team-org-panel-head">{heading}<em>{view.coverage.length} locations</em></summary>{table}</details>
    : <section className="panel team-org-panel"><div className="team-org-panel-head">{heading}</div>{table}</section>;
}

function Directory({ view, graph, companyName, anchorId, onAnchor }: { view: TeamOrgView; graph: Graph; companyName: string; anchorId: string | null; onAnchor: (id: string | null) => void }) {
  const [search, setSearch] = useState("");
  const [allLevels, setAllLevels] = useState(false);
  const [limit, setLimit] = useState(DIRECTORY_PAGE_SIZE);
  const term = useDeferredValue(search).trim().toLowerCase();
  const anchor = anchorId ? graph.byId.get(anchorId) ?? null : null;
  const selfId = view.selfIds[0] ?? null;

  useEffect(() => setLimit(DIRECTORY_PAGE_SIZE), [term, anchorId, allLevels]);

  const rows = useMemo(() => {
    if (term) return view.nodes.filter((node) => matches(node, term)).map((node) => ({ node, depth: 0 }));
    if (anchor) return reportsOf(graph, anchor.id, allLevels);
    const base = view.mode === "company"
      ? view.nodes.filter((node) => !node.managerId)
      : view.nodes.filter((node) => node.relation !== "upline");
    return base.map((node) => ({ node, depth: 0 }));
  }, [allLevels, anchor, graph, term, view]);
  const breadcrumbs = useMemo(() => anchor ? [...lineAbove(graph, anchor.id), anchor] : [], [anchor, graph]);
  const totalBelow = useMemo(() => anchor ? reportsOf(graph, anchor.id, true).length : 0, [anchor, graph]);

  function focus(id: string | null) {
    setSearch("");
    setAllLevels(false);
    onAnchor(id);
  }

  const scopeLabel = view.mode === "company" ? "Company view" : `My scope (${view.counts.people})`;
  return <section className="panel team-org-panel" id="team-org-directory">
    <div className="team-org-panel-head">
      <div>
        <h2>Team directory</h2>
        <p>Select a person to see who reports to them. The path shows who they report up to.</p>
      </div>
      <div className="team-org-actions">
        <label className="team-org-search">
          <Search size={14} aria-hidden="true" />
          <input aria-label="Search team directory" placeholder="Search name, ID, role, department or location" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        {selfId ? <button className={`button secondary${anchorId === selfId && !term ? " active" : ""}`} type="button" onClick={() => focus(selfId)}>My team</button> : null}
        <button className={`button secondary${!anchorId && !term ? " active" : ""}`} type="button" onClick={() => focus(null)}>{scopeLabel}</button>
      </div>
    </div>

    {anchor && !term ? <div className="team-org-focus">
      <div className="team-org-focus-head">
        <Avatar name={anchor.name} />
        <div><strong>{anchor.name}{anchor.relation === "self" ? " (you)" : ""}</strong><span>{[anchor.title, anchor.department, anchor.location].filter(Boolean).join(" · ")}</span></div>
      </div>
      <nav className="team-org-breadcrumb" aria-label="Reporting path">
        <span>{companyName}</span>
        {breadcrumbs.map((node) => <span key={node.id}>
          <ChevronRight size={12} aria-hidden="true" />
          <button type="button" className={node.id === anchor.id ? "current" : ""} onClick={() => focus(node.id)}>{node.name}</button>
        </span>)}
      </nav>
      <div className="team-org-level-switch">
        <button className={allLevels ? "" : "active"} type="button" onClick={() => setAllLevels(false)}>Direct reports ({graph.children.get(anchor.id)?.length ?? 0})</button>
        <button className={allLevels ? "active" : ""} type="button" onClick={() => setAllLevels(true)}>All levels ({totalBelow})</button>
      </div>
    </div> : null}

    <div className="table-wrap team-org-table-wrap">
      <table className="team-org-table">
        <thead><tr><th>Person</th><th>Reports to</th><th>Cluster manager</th><th>Department</th><th>Location</th><th>Team</th></tr></thead>
        <tbody>
          {rows.slice(0, limit).map(({ node, depth }) => {
            const manager = node.managerId ? graph.byId.get(node.managerId) ?? null : null;
            const reports = graph.children.get(node.id)?.length ?? 0;
            return <tr key={node.id} className={node.relation === "self" ? "self" : ""}>
              <td>
                <div className="team-org-row-person" style={{ paddingLeft: depth * 18 }}>
                  <Avatar name={node.name} />
                  <div>
                    <button type="button" className="team-org-link" onClick={() => focus(node.id)}>{node.name}</button>
                    {node.relation === "self" ? <em>You</em> : node.relation === "upline" ? <em className="upline">Reporting line</em> : null}
                    <small>{node.title}{node.code ? ` · ${node.code}` : ""}</small>
                  </div>
                </div>
              </td>
              <td>{manager
                ? <button type="button" className="team-org-link" onClick={() => focus(manager.id)}>{manager.name}</button>
                : node.isTopLevel ? <span className="team-org-muted">Company level</span> : <span className="team-org-flag">Manager not mapped</span>}</td>
              <td>{node.clusterManager ?? <span className="team-org-muted">—</span>}</td>
              <td>{node.department ?? <span className="team-org-muted">—</span>}</td>
              <td>{node.location ?? <span className="team-org-muted">—</span>}</td>
              <td>{reports ? <button className="button secondary team-org-team" type="button" onClick={() => focus(node.id)}>View team ({reports})</button> : null}</td>
            </tr>;
          })}
          {!rows.length ? <tr><td className="team-org-empty-cell" colSpan={6}>{term ? "No one in your scope matches this search." : anchor ? `No one reports to ${anchor.name}.` : "No people are mapped in this view."}</td></tr> : null}
        </tbody>
      </table>
    </div>
    {rows.length > limit ? <div className="team-org-more">
      <span>Showing {limit} of {rows.length}</span>
      <button className="button secondary" type="button" onClick={() => setLimit((current) => current + DIRECTORY_PAGE_SIZE)}>Show more</button>
    </div> : null}
  </section>;
}

export function OpsTeamOrg({ view, companyName }: { view: TeamOrgView; companyName: string }) {
  const graph = useMemo(() => buildGraph(view.nodes), [view.nodes]);
  const [anchorId, setAnchorId] = useState<string | null>(view.selfIds[0] ?? null);
  const stats = view.mode === "location"
    ? [["Locations", view.counts.locations], ["People", view.counts.people]]
    : view.selfIds.length
      ? [["Levels above you", view.counts.uplineLevels], ["Direct reports", view.counts.directReports], ["Total team", view.counts.team], ["Locations", view.counts.locations]]
      : [["People", view.counts.people], ["Locations", view.counts.locations]];
  const intro = view.mode === "company"
    ? "Everyone in the company, following current People reporting lines."
    : view.mode === "location"
      ? "The people posted at your location, and the cluster they report up to."
      : "Who you report up to, and everyone who reports to you.";

  function focusInDirectory(id: string) {
    setAnchorId(id);
    document.getElementById("team-org-directory")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return <div className="team-org">
    <section className="panel team-org-intro">
      <div>
        <span className="team-org-eyebrow">TEAM OPS · MY TEAM &amp; ORG</span>
        <h1>My Team &amp; Org</h1>
        <p>{intro}</p>
      </div>
      {view.mode !== "none" ? <dl>{stats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
    </section>
    {view.mode === "none" ? <section className="panel team-org-none">
      <strong>Nothing to show for this login yet</strong>
      <p>This login is not linked to a People profile and has no location assigned. Ask HR to link your profile, or an Ops admin to assign your locations.</p>
    </section> : <>
      {view.mode === "location" ? <Coverage view={view} /> : null}
      <Chart view={view} graph={graph} companyName={companyName} onFocus={focusInDirectory} />
      {view.mode !== "location" ? <Coverage view={view} /> : null}
      <Directory view={view} graph={graph} companyName={companyName} anchorId={anchorId} onAnchor={setAnchorId} />
    </>}
  </div>;
}
