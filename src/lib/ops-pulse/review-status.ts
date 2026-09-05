export const REVIEW_STATUS_MAX_DAYS = 31;

export type ReviewStatusLocation = {
  id: string;
  station_code: string;
  station_name: string | null;
  city?: string | null;
  region?: string | null;
  aom?: string | null;
  aom_names?: string[];
  cluster_manager?: string | null;
  cluster_manager_names?: string[];
  cluster?: string | null;
  reporting_authorities?: Array<{ name: string; role: string }>;
};

export type ReviewStatusKind = "not_started" | "in_progress" | "completed";

export type ReviewStatusReview = {
  id: string;
  source_date: string;
  station_id: string;
  station_code: string;
  source_type: string;
  status: "open" | "in_review" | "closed";
  current_step_order: number;
  review_summary: string | null;
  started_at: string;
  closed_at: string | null;
  updated_at: string;
};

export type ReviewStatusStep = {
  id: string;
  review_id: string;
  step_order: number;
  reviewer_name: string;
  reviewer_role: string;
  status: "pending" | "completed" | "skipped";
  feedback: string | null;
  completed_at: string | null;
  bypass_reason: string | null;
  bypassed_at: string | null;
  bypassed_by_name: string | null;
  proxy_reviewer_name: string | null;
  proxy_reason: string | null;
  proxy_started_at: string | null;
};

export type ReviewStatusItem = {
  review_id: string;
  metric_label: string;
  status: "open" | "in_progress" | "blocked" | "done";
  root_cause: string | null;
  corrective_action: string | null;
  action_owner: string | null;
  due_date: string | null;
};

export type ReviewStatusUpdate = {
  review_id: string;
  update_type: string;
  note: string;
  author_name: string | null;
  author_role: string | null;
  stage_label: string | null;
  created_at: string;
};

export type ReviewStatusFollowup = {
  review_id: string;
  action_number: number;
  title: string;
  owner_label: string;
  due_date: string;
  status: "open" | "in_progress" | "blocked" | "done";
};

export type ReviewStatusRow = {
  key: string;
  date: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  region: string;
  clusterManager: string;
  aom: string;
  nationalHead: string;
  status: ReviewStatusKind;
  review: ReviewStatusReview | null;
  steps: ReviewStatusStep[];
  items: ReviewStatusItem[];
  updates: ReviewStatusUpdate[];
  followups: ReviewStatusFollowup[];
  completedSteps: number;
  skippedSteps: number;
  totalSteps: number;
  currentDependency: string;
  lastActivityAt: string | null;
};

function dateShift(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(value: string | null | undefined) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : null;
}

export function reviewStatusDateRange(input: { from?: string | null; to?: string | null; latestDate: string }) {
  const latestDate = validDate(input.latestDate) ?? new Date().toISOString().slice(0, 10);
  const to = [validDate(input.to), latestDate].filter(Boolean).sort()[0] as string;
  const requestedFrom = validDate(input.from) ?? to;
  const earliest = dateShift(to, -(REVIEW_STATUS_MAX_DAYS - 1));
  const from = requestedFrom > to ? to : requestedFrom < earliest ? earliest : requestedFrom;
  return { from, to, days: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1 };
}

export function reviewStatusDates(from: string, to: string) {
  const dates: string[] = [];
  for (let current = to; current >= from; current = dateShift(current, -1)) dates.push(current);
  return dates;
}

function statusReviewRole(value: string | null | undefined) {
  const role = ` ${String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  if (/\b(CLM|CM|CLUSTER MANAGER|CLUSTER HEAD|CLUSTER MGR)\b/.test(role)) return "cluster";
  if (/\b(AOM|AM|AREA OPERATIONS? MANAGER|AREA MANAGER)\b/.test(role)) return "aom";
  if (/\b(NH|NATIONAL HEAD)\b/.test(role)) return "national";
  return "other";
}

function stepName(steps: ReviewStatusStep[], role: "cluster" | "aom" | "national") {
  return steps.find((step) => statusReviewRole(step.reviewer_role) === role)?.reviewer_name ?? "";
}

function hierarchyName(location: ReviewStatusLocation, role: "cluster" | "aom" | "national") {
  if (role === "cluster") return location.cluster_manager_names?.[0] ?? location.cluster_manager ?? location.cluster ?? "";
  if (role === "aom") return location.aom_names?.[0] ?? location.aom ?? "";
  return location.reporting_authorities?.find((person) => statusReviewRole(person.role) === "national")?.name ?? "";
}

function reviewKey(stationId: string, date: string) {
  return `${stationId}|${date}`;
}

export function buildReviewStatusRows(input: {
  dates: string[];
  locations: ReviewStatusLocation[];
  reviews: ReviewStatusReview[];
  steps: ReviewStatusStep[];
  items: ReviewStatusItem[];
  updates: ReviewStatusUpdate[];
  followups: ReviewStatusFollowup[];
}) {
  const reviewByKey = new Map<string, ReviewStatusReview>();
  const stationIdByCode = new Map(input.locations.map((location) => [location.station_code.trim().toUpperCase(), location.id]));
  input.reviews.forEach((review) => {
    const stationId = review.station_id || stationIdByCode.get(review.station_code.trim().toUpperCase());
    if (!stationId) return;
    const key = reviewKey(stationId, review.source_date);
    const current = reviewByKey.get(key);
    if (!current || current.updated_at < review.updated_at) reviewByKey.set(key, review);
  });

  const groupByReview = <T extends { review_id: string }>(rows: T[]) => {
    const grouped = new Map<string, T[]>();
    rows.forEach((row) => grouped.set(row.review_id, [...(grouped.get(row.review_id) ?? []), row]));
    return grouped;
  };
  const stepsByReview = groupByReview(input.steps);
  const itemsByReview = groupByReview(input.items);
  const updatesByReview = groupByReview(input.updates);
  const followupsByReview = groupByReview(input.followups);

  return input.dates.flatMap((date) => input.locations.map((location): ReviewStatusRow => {
    const review = reviewByKey.get(reviewKey(location.id, date)) ?? null;
    const steps = review ? [...(stepsByReview.get(review.id) ?? [])].sort((left, right) => left.step_order - right.step_order) : [];
    const currentStep = steps.find((step) => step.status === "pending" && step.step_order === review?.current_step_order)
      ?? steps.find((step) => step.status === "pending");
    const status: ReviewStatusKind = !review ? "not_started" : review.status === "closed" ? "completed" : "in_progress";
    const lastStepAt = steps.reduce<string | null>((latest, step) => !step.completed_at || (latest && latest > step.completed_at) ? latest : step.completed_at, null);
    return {
      key: reviewKey(location.id, date),
      date,
      stationId: location.id,
      stationCode: location.station_code,
      stationName: location.station_name || location.city || "Station",
      region: location.region ?? "",
      clusterManager: stepName(steps, "cluster") || hierarchyName(location, "cluster"),
      aom: stepName(steps, "aom") || hierarchyName(location, "aom"),
      nationalHead: stepName(steps, "national") || hierarchyName(location, "national"),
      status,
      review,
      steps,
      items: review ? itemsByReview.get(review.id) ?? [] : [],
      updates: review ? updatesByReview.get(review.id) ?? [] : [],
      followups: review ? followupsByReview.get(review.id) ?? [] : [],
      completedSteps: steps.filter((step) => step.status === "completed").length,
      skippedSteps: steps.filter((step) => step.status === "skipped").length,
      totalSteps: steps.length,
      currentDependency: currentStep ? `${currentStep.reviewer_role} · ${currentStep.proxy_reviewer_name || currentStep.reviewer_name}` : status === "completed" ? "Completed" : "Start review",
      lastActivityAt: review ? review.closed_at || lastStepAt || review.updated_at || review.started_at : null
    };
  }));
}
