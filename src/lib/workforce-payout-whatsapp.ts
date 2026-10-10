import {
  extractWhatsAppTemplateVariables,
  type WhatsAppTemplateComponent
} from "@/lib/whatsapp-template";

export const WORKFORCE_PAYOUT_WHATSAPP_EVENT = "workforce_payout_review";

export const WORKFORCE_PAYOUT_WHATSAPP_FIELDS = [
  { value: "full_name", label: "Associate name" },
  { value: "dropx_id", label: "DropX ID" },
  { value: "station_code", label: "Station code" },
  { value: "payment_label", label: "Payment label" },
  { value: "payout_period", label: "Payout period" },
  { value: "gross_amount", label: "Gross payment" },
  { value: "deduction_amount", label: "Gross deductions" },
  { value: "net_amount", label: "Net payment" },
  { value: "work_days", label: "Work days" },
  { value: "review_deadline", label: "Review deadline" },
  { value: "payout_url", label: "DropX One payout URL" }
] as const;

export type WorkforcePayoutWhatsAppField = typeof WORKFORCE_PAYOUT_WHATSAPP_FIELDS[number]["value"];
export type WorkforcePayoutWhatsAppValues = Record<WorkforcePayoutWhatsAppField, string>;

const DROPX_ONE_PAYOUT_ORIGIN = "https://one.dropxlogistics.com";

export function workforcePayoutDeepLink(snapshot: PayoutSnapshot | null | undefined, person: { dropx_id?: unknown }) {
  const item = snapshot?.item ?? {};
  const periodEnd = String(snapshot?.run?.period_end ?? "").trim();
  const payoutMonth = /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(periodEnd) ? periodEnd.slice(0, 7) : "";
  const dropxId = String(item.dropx_id ?? person.dropx_id ?? "").trim();
  const url = new URL("/payments", DROPX_ONE_PAYOUT_ORIGIN);
  url.searchParams.set("tab", "payouts");
  if (payoutMonth) url.searchParams.set("payoutMonth", payoutMonth);
  if (dropxId) url.searchParams.set("id", dropxId);
  return url.toString();
}

export function normalizeWorkforceWhatsAppRecipient(mobile: unknown, countryCode: unknown) {
  const digits = String(mobile ?? "").replace(/\D/g, "");
  const prefix = String(countryCode ?? "91").replace(/\D/g, "") || "91";
  const recipient = digits.startsWith(prefix) && digits.length > 10 ? digits : `${prefix}${digits}`;
  return /^\d{11,15}$/.test(recipient) ? recipient : null;
}

type PayoutSnapshot = {
  run?: { period_start?: unknown; period_end?: unknown };
  item?: {
    worker_name?: unknown;
    dropx_id?: unknown;
    station_code?: unknown;
    location_code?: unknown;
    gross_amount?: unknown;
    gross_deduction?: unknown;
    gross_deductions?: unknown;
    deduction_amount?: unknown;
    net_amount?: unknown;
    work_days?: unknown;
  };
};

function text(value: unknown, fallback = "-") {
  return String(value ?? "").replace(/\s+/g, " ").trim() || fallback;
}

function money(value: unknown) {
  const amount = Number(value ?? 0);
  return `Rs ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number.isFinite(amount) ? amount : 0)}`;
}

function indianDate(value: unknown, includeTime = false) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Asia/Kolkata"
  }).format(date);
}

function dynamicButtonUrlSuffix(templateUrl: unknown, resolvedValue: string) {
  const template = String(templateUrl ?? "").trim();
  const marker = template.match(/\{\{\d+\}\}/)?.[0];
  if (!marker || !/^https?:\/\//i.test(resolvedValue)) return resolvedValue;
  const prefix = template.slice(0, template.indexOf(marker));
  const trailing = template.slice(template.indexOf(marker) + marker.length);
  if (resolvedValue.startsWith(prefix) && (!trailing || resolvedValue.endsWith(trailing))) {
    return resolvedValue.slice(prefix.length, trailing ? -trailing.length : undefined);
  }
  try {
    const target = new URL(resolvedValue);
    const templatePrefix = new URL(prefix);
    if (target.origin === templatePrefix.origin && templatePrefix.pathname.endsWith("/")) {
      const basePath = templatePrefix.pathname;
      if (target.pathname.startsWith(basePath)) {
        return `${target.pathname.slice(basePath.length)}${target.search}${target.hash}`;
      }
    }
  } catch {
    // The validation below reports a configuration-safe error.
  }
  throw new Error("The payout URL does not match the approved WhatsApp button base URL. Update the template or variable mapping.");
}

export function workforcePayoutWhatsAppValues({
  snapshot,
  person,
  reviewUntil,
  payoutUrl
}: {
  snapshot: PayoutSnapshot | null | undefined;
  person: { full_name?: unknown; dropx_id?: unknown };
  reviewUntil: unknown;
  payoutUrl?: string;
}): WorkforcePayoutWhatsAppValues {
  const item = snapshot?.item ?? {};
  const run = snapshot?.run ?? {};
  const start = indianDate(run.period_start);
  const end = indianDate(run.period_end);
  const deductions = item.gross_deductions ?? item.gross_deduction ?? item.deduction_amount;
  return {
    full_name: text(item.worker_name ?? person.full_name, "Associate"),
    dropx_id: text(item.dropx_id ?? person.dropx_id),
    station_code: text(item.station_code ?? item.location_code),
    payment_label: "Payment",
    payout_period: start === end ? start : `${start} to ${end}`,
    gross_amount: money(item.gross_amount),
    deduction_amount: money(deductions),
    net_amount: money(item.net_amount),
    work_days: text(item.work_days, "0"),
    review_deadline: indianDate(reviewUntil, true),
    payout_url: payoutUrl || workforcePayoutDeepLink(snapshot, person)
  };
}

export function buildWorkforcePayoutTemplateComponents(
  components: WhatsAppTemplateComponent[],
  mappings: Record<string, string>,
  values: WorkforcePayoutWhatsAppValues
) {
  const variables = extractWhatsAppTemplateVariables(components);
  const variableKeys = new Set(variables.map((variable) => variable.key));
  const allowedFields = new Set<string>(WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => field.value));
  const unknownMappings = Object.entries(mappings).filter(([key, source]) => !variableKeys.has(key) || !allowedFields.has(source));
  if (unknownMappings.length) throw new Error("The payout notification contains an unsupported variable mapping. Save the configuration again.");

  const missing = variables.filter((variable) => !mappings[variable.key]);
  if (missing.length) throw new Error(`The payout notification is missing mappings for: ${missing.map((item) => item.label).join(", ")}.`);
  const empty = variables.filter((variable) => !String(values[mappings[variable.key] as WorkforcePayoutWhatsAppField] ?? "").trim());
  if (empty.length) throw new Error(`Payout data is unavailable for: ${empty.map((item) => item.label).join(", ")}.`);

  const result: Array<Record<string, unknown>> = [];
  (["header", "body"] as const).forEach((componentType) => {
    const matching = variables
      .filter((variable) => variable.component === componentType)
      .sort((left, right) => left.position - right.position);
    if (!matching.length) return;
    result.push({
      type: componentType,
      parameters: matching.map((variable) => ({
        type: "text",
        text: values[mappings[variable.key] as WorkforcePayoutWhatsAppField]
      }))
    });
  });
  variables.filter((variable) => variable.component === "button").forEach((variable) => {
    const source = mappings[variable.key] as WorkforcePayoutWhatsAppField;
    const buttonUrl = components
      .find((component) => component.type?.toUpperCase() === "BUTTONS")
      ?.buttons?.[variable.buttonIndex ?? 0]?.url;
    const resolved = values[source];
    result.push({
      type: "button",
      sub_type: "url",
      index: String(variable.buttonIndex ?? 0),
      parameters: [{
        type: "text",
        text: source === "payout_url" ? dynamicButtonUrlSuffix(buttonUrl, resolved) : resolved
      }]
    });
  });
  return result;
}
