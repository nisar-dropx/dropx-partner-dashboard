"use client";

import { Award, BarChart3, CalendarDays, Check, ChevronDown, CircleGauge, MapPinned, Sparkles, Target, TrendingUp, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AppAccount } from "./connect-profile-app";

type Cycle = { id: string; name: string; period_start: string; period_end: string; self_review_due: string | null; manager_review_due: string | null; status: string; rating_scale: number };
type Review = { id: string; cycle_id: string; worker_name?: string | null; worker_code?: string | null; status: string; designation_name: string | null; department_name: string | null; self_rating: number | null; manager_rating: number | null; final_rating: number | null; self_comments: string | null; manager_comments: string | null; calibration_comments: string | null; self_submitted_at: string | null; manager_submitted_at: string | null; acknowledged_at: string | null };
type Goal = { id: string; review_id: string; title: string; description: string | null; metric: string | null; target_value: string | null; actual_value: string | null; weight: number; progress: number; status: string };
type Change = { id: string; review_id: string | null; change_type: string; previous_pay: number | null; proposed_pay: number | null; pay_basis: string | null; effective_from: string; reason: string; status: string };
type Metric = { key: string; label: string; value: number | null; target: number | null; direction: "higher" | "lower"; weight: number; unit: "percent" | "dpmo" | "ratio"; status: "achieved" | "near" | "missed" | "reference" };
type Operational = {
  scopeLabel: string; stationCount: number; availableWeeks: number[]; selectedWeek: number | null; selectedYear: number | null; averageSls: number | null; averageAttainment: number | null; cpsOnTarget: number; cpsMeasured: number; standingCounts: Record<string, number>;
  stations: Array<{ id: string; code: string; name: string; region: string | null; model: string | null; sls: { score: number; standing: string; achievedWeight: number; availableWeight: number; attainment: number; metrics: Metric[] } | null; cps: { date: string; value: number; target: number | null; gap: number | null; onTarget: boolean | null } | null }>;
};
type Payload = { configured: boolean; cycles: Cycle[]; reviews: Review[]; managerReviews: Review[]; goals: Goal[]; changes: Change[]; operational: Operational | null };

function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function date(value?: string | null) { if (!value) return "—"; const parsed = new Date(`${value.slice(0, 10)}T00:00:00`); return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parsed); }
function money(value?: number | null) { return value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value); }
function percent(value?: number | null) { return value == null ? "—" : `${(value * 100).toFixed(1)}%`; }
function metricValue(metric: Metric) { if (metric.value == null) return "—"; return metric.unit === "dpmo" ? Math.round(metric.value).toLocaleString("en-IN") : percent(metric.value); }
function metricTarget(metric: Metric) { if (metric.target == null) return "Reference"; const value = metric.unit === "dpmo" ? Math.round(metric.target).toLocaleString("en-IN") : percent(metric.target); return `${metric.direction === "higher" ? "≥" : "≤"} ${value}`; }

function Status({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = ["finalised", "acknowledged", "completed", "approved", "applied", "fantastic", "great"].includes(normalized) ? "good" : ["at_risk", "blocked", "rejected", "cancelled", "poor"].includes(normalized) ? "danger" : "pending";
  return <span className={`dx-performance-status ${tone}`}>{label(value)}</span>;
}

export function ConnectPerformance({ account }: { account: AppAccount }) {
  const [data, setData] = useState<Payload | null>(null);
  const [section, setSection] = useState<"scorecards" | "reviews">("scorecards");
  const [week, setWeek] = useState<number | null>(null);
  const [activeReviewId, setActiveReviewId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setLoading(true); setError("");
    const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
    if (week) query.set("week", String(week));
    fetch(`/api/connect/performance?${query}`, { cache: "no-store" })
      .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Unable to load performance."); return payload as Payload; })
      .then((payload) => { setData(payload); setWeek((current) => current ?? payload.operational?.selectedWeek ?? null); setActiveReviewId((current) => payload.reviews.some((item) => item.id === current) ? current : payload.reviews[0]?.id ?? ""); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load performance."))
      .finally(() => setLoading(false));
  }, [account.id, account.profileType, refresh, week]);

  const cycles = useMemo(() => new Map((data?.cycles ?? []).map((item) => [item.id, item])), [data?.cycles]);
  const activeReview = data?.reviews.find((item) => item.id === activeReviewId) ?? data?.reviews[0] ?? null;
  const activeCycle = activeReview ? cycles.get(activeReview.cycle_id) ?? null : null;
  const goals = activeReview ? (data?.goals ?? []).filter((item) => item.review_id === activeReview.id) : [];
  const changes = activeReview ? (data?.changes ?? []).filter((item) => item.review_id === activeReview.id) : [];
  const completedGoals = goals.filter((item) => item.status === "completed").length;
  const averageProgress = goals.length ? Math.round(goals.reduce((sum, item) => sum + item.progress, 0) / goals.length) : 0;

  async function submit(body: Record<string, unknown>) {
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, accountId: account.id, profileType: account.profileType }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to save performance details.");
      setNotice(payload.notice || "Saved."); setRefresh((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save performance details."); } finally { setSaving(false); }
  }

  function submitSelfReview(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!activeReview) return; const form = new FormData(event.currentTarget); void submit({ action: "self_review", reviewId: activeReview.id, selfRating: form.get("selfRating"), comments: form.get("comments") }); }
  function submitManagerReview(event: FormEvent<HTMLFormElement>, reviewId: string) { event.preventDefault(); const form = new FormData(event.currentTarget); void submit({ action: "manager_review", reviewId, managerRating: form.get("managerRating"), comments: form.get("comments") }); }
  function updateGoal(event: FormEvent<HTMLFormElement>, goal: Goal) { event.preventDefault(); if (!activeReview) return; const form = new FormData(event.currentTarget); void submit({ action: "goal_progress", reviewId: activeReview.id, goalId: goal.id, progress: form.get("progress"), status: form.get("status"), actualValue: form.get("actualValue") }); }

  if (loading && !data) return <div className="dx-loader fullscreen"><span /><small>Loading performance...</small></div>;
  if (error && !data) return <div className="dx-alert error">{error}<button onClick={() => setRefresh((value) => value + 1)}>Retry</button></div>;
  if (!data?.configured) return <section className="dx-performance"><header className="dx-page-intro"><small>Performance</small><h1>My performance</h1><p>Your People profile needs to be linked first.</p></header><div className="dx-performance-empty"><Target /><strong>Performance profile not configured</strong><span>Ask HR to complete your active People assignment.</span></div></section>;

  const operational = data.operational;
  return <section className="dx-performance dx-performance-product">
    <header className="dx-page-intro dx-performance-intro"><div><small>Performance</small><h1>My performance</h1><p>Station scorecards and personal reviews, kept separate and clear.</p></div>{section === "scorecards" && operational?.availableWeeks.length ? <label><span className="sr-only">SLS week</span><select value={week ?? ""} onChange={(event) => setWeek(Number(event.target.value))}>{operational.availableWeeks.map((item) => <option key={item} value={item}>Week {item}</option>)}</select><ChevronDown /></label> : null}</header>
    <nav className="dx-performance-sections" aria-label="Performance sections"><button className={section === "scorecards" ? "active" : ""} onClick={() => setSection("scorecards")}><BarChart3 /> Scorecards</button><button className={section === "reviews" ? "active" : ""} onClick={() => setSection("reviews")}><Award /> Reviews{data.managerReviews.length ? <b>{data.managerReviews.length}</b> : null}</button></nav>
    {error ? <div className="dx-alert error">{error}</div> : null}{notice ? <div className="dx-alert success">{notice}</div> : null}

    {section === "scorecards" ? <>
      <section className="dx-performance-portfolio-hero"><div><span><MapPinned /> {operational?.scopeLabel ?? "People scope"}</span><strong>{operational?.selectedWeek ? `SLS · Week ${operational.selectedWeek}` : "SLS scorecard"}</strong><small>{operational?.selectedYear ?? "Latest uploaded week"}</small></div><dl><div><dt>Average SLS</dt><dd>{percent(operational?.averageSls)}</dd></div><div><dt>Target attainment</dt><dd>{operational?.averageAttainment == null ? "—" : `${operational.averageAttainment}%`}</dd></div><div><dt>CPS on target</dt><dd>{operational?.cpsMeasured ? `${operational.cpsOnTarget}/${operational.cpsMeasured}` : "—"}</dd></div></dl></section>
      {operational?.stations.length ? <section className="dx-performance-station-list"><header><div><small>My portfolio</small><h2>{operational.stations.length} scored station{operational.stations.length === 1 ? "" : "s"}</h2></div><span>Open a station for details</span></header>{operational.stations.map((station) => <details key={station.id} className="dx-performance-station-card" open={operational.stations.length === 1}><summary><div><i>{station.code}</i><span><strong>{station.name}</strong><small>{[station.model, station.region].filter(Boolean).join(" · ") || "Mapped location"}</small></span></div><div>{station.sls ? <><Status value={station.sls.standing} /><b>{percent(station.sls.score)}</b></> : <span className="dx-performance-muted">SLS pending</span>}{station.cps ? <em className={station.cps.onTarget === false ? "missed" : ""}>CPS ₹{station.cps.value.toFixed(2)}</em> : null}</div><ChevronDown /></summary><div className="dx-performance-station-detail"><div className="dx-performance-station-summary"><span><small>SLS score</small><strong>{percent(station.sls?.score)}</strong></span><span><small>Weighted targets</small><strong>{station.sls ? `${station.sls.attainment}%` : "—"}</strong></span><span><small>CPS / target</small><strong>{station.cps ? `₹${station.cps.value.toFixed(2)} / ${station.cps.target == null ? "—" : `₹${station.cps.target.toFixed(2)}`}` : "—"}</strong></span></div>{station.sls?.metrics.length ? <div className="dx-performance-metric-grid">{station.sls.metrics.map((metric) => <article className={metric.status} key={metric.key}><span>{metric.label}</span><strong>{metricValue(metric)}</strong><small>Target {metricTarget(metric)}{metric.weight ? ` · ${metric.weight}% weight` : ""}</small></article>)}</div> : <div className="dx-performance-empty compact"><Target /><strong>Detailed SLS metrics pending</strong><span>The uploaded scorecard has no active mapped metrics for this station.</span></div>}</div></details>)}</section> : <div className="dx-performance-empty"><BarChart3 /><strong>No scorecard is available for your mapped locations</strong><span>SLS appears after the weekly upload; CPS appears after station cost calculation.</span></div>}
    </> : <>
      {data.reviews.length ? <>
        <header className="dx-performance-review-picker"><div><small>Personal review</small><h2>My goals & feedback</h2></div><label><span className="sr-only">Performance cycle</span><select value={activeReview?.id ?? ""} onChange={(event) => setActiveReviewId(event.target.value)}>{data.reviews.map((review) => <option key={review.id} value={review.id}>{cycles.get(review.cycle_id)?.name ?? "Performance review"}</option>)}</select><ChevronDown /></label></header>
        <section className="dx-performance-hero"><div><span><Award /> {activeReview?.designation_name || "People team"}</span><h2>{activeCycle?.name ?? "Performance review"}</h2><p>{date(activeCycle?.period_start)} – {date(activeCycle?.period_end)}</p></div><Status value={activeReview?.status ?? "assigned"} /><dl><div><dt><Target /> Goals</dt><dd>{completedGoals}/{goals.length}</dd></div><div><dt><CircleGauge /> Progress</dt><dd>{averageProgress}%</dd></div><div><dt><TrendingUp /> Rating</dt><dd>{activeReview?.final_rating ?? activeReview?.manager_rating ?? activeReview?.self_rating ?? "—"}<small>/{activeCycle?.rating_scale ?? 5}</small></dd></div></dl></section>
        {activeReview?.status === "assigned" ? <form className="dx-performance-card dx-performance-self" onSubmit={submitSelfReview}><header><div><small>Your reflection</small><h2>Self-review</h2></div><span><CalendarDays /> Due {date(activeCycle?.self_review_due)}</span></header><label>How would you rate this period?<input max={activeCycle?.rating_scale ?? 5} min="1" name="selfRating" required step="1" type="number" /></label><label>Contribution and development focus<textarea minLength={10} name="comments" placeholder="What went well? Where would support help?" required /></label><button disabled={saving}>{saving ? "Submitting..." : "Submit to manager"}</button></form> : null}
        {activeReview && activeReview.status !== "assigned" ? <section className="dx-performance-card dx-performance-feedback"><header><div><small>Review journey</small><h2>Feedback</h2></div><Status value={activeReview.status} /></header><div><article><small>Your reflection</small><strong>{activeReview.self_rating ?? "—"}/{activeCycle?.rating_scale ?? 5}</strong><p>{activeReview.self_comments || "Submitted"}</p></article><article><small>Manager feedback</small><strong>{activeReview.manager_rating ?? "—"}/{activeCycle?.rating_scale ?? 5}</strong><p>{activeReview.manager_comments || "Awaiting manager review"}</p></article>{activeReview.final_rating != null ? <article className="final"><small>Final outcome</small><strong>{activeReview.final_rating}/{activeCycle?.rating_scale ?? 5}</strong><p>{activeReview.calibration_comments || "Final rating approved"}</p></article> : null}</div>{activeReview.status === "finalised" ? <button disabled={saving} onClick={() => void submit({ action: "acknowledge", reviewId: activeReview.id })}><Check /> {saving ? "Saving..." : "Acknowledge outcome"}</button> : null}</section> : null}
        <section className="dx-performance-card dx-performance-goals"><header><div><small>Focus</small><h2>Goals</h2></div><span>{averageProgress}% overall</span></header>{goals.length ? <div>{goals.map((goal) => <form key={goal.id} onSubmit={(event) => updateGoal(event, goal)}><header><div><strong>{goal.title}</strong><small>{goal.metric || "Development goal"}{goal.target_value ? ` · ${goal.target_value}` : ""}</small></div><Status value={goal.status} /></header><p>{goal.description}</p><div className="dx-performance-progress"><i><b style={{ width: `${goal.progress}%` }} /></i><strong>{goal.progress}%</strong></div>{!["finalised", "acknowledged", "closed"].includes(activeReview?.status ?? "") ? <details><summary>Update progress</summary><div><label>Progress<input defaultValue={goal.progress} max="100" min="0" name="progress" type="number" /></label><label>Status<select defaultValue={goal.status} name="status"><option value="not_started">Not started</option><option value="on_track">On track</option><option value="at_risk">At risk</option><option value="blocked">Blocked</option><option value="completed">Completed</option></select></label><label>Result<input defaultValue={goal.actual_value ?? ""} name="actualValue" placeholder="Latest outcome" /></label><button disabled={saving}>Save</button></div></details> : null}</form>)}</div> : <div className="dx-performance-empty compact"><Target /><strong>No goals recorded</strong><span>Your manager or HR can add goals to this review.</span></div>}</section>
        {changes.length ? <section className="dx-performance-card dx-performance-decisions"><header><div><small>Decisions</small><h2>Pay, incentive & role history</h2></div></header>{changes.map((change) => <article key={change.id}><div><strong>{label(change.change_type)}</strong><span>{date(change.effective_from)}</span></div><p>{change.reason}</p><footer><span>{money(change.previous_pay)} <b>→</b> {money(change.proposed_pay)}</span><Status value={change.status} /></footer></article>)}</section> : null}
      </> : <div className="dx-performance-empty"><Sparkles /><strong>No personal review yet</strong><span>Your review appears when HR launches a cycle for your People scope.</span></div>}
      {data.managerReviews.length ? <section className="dx-performance-team-reviews"><header><div><small>Manager action</small><h2>Team reviews</h2></div><span><UsersRound /> {data.managerReviews.length}</span></header>{data.managerReviews.map((review) => { const cycle = cycles.get(review.cycle_id); const editable = ["self_submitted", "manager_submitted"].includes(review.status); return <details className="dx-performance-team-card" key={review.id}><summary><div><strong>{review.worker_name || "Team member"}</strong><small>{review.worker_code || review.designation_name || "People profile"} · {cycle?.name || "Review"}</small></div><Status value={review.status} /><ChevronDown /></summary><div><p>{review.self_comments || "Self-review is still pending."}</p>{editable ? <form onSubmit={(event) => submitManagerReview(event, review.id)}><label>Rating<input defaultValue={review.manager_rating ?? ""} max={cycle?.rating_scale ?? 5} min="1" name="managerRating" required step="1" type="number" /></label><label>Feedback<textarea defaultValue={review.manager_comments ?? ""} minLength={10} name="comments" required /></label><button disabled={saving}>{saving ? "Submitting..." : "Submit manager review"}</button></form> : <span className="dx-performance-muted">No manager action is due.</span>}</div></details>; })}</section> : null}
    </>}
  </section>;
}
