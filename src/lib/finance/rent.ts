import { addAmounts, decimal, mgEstimate, subtractAmounts } from "./pricing";

export type RentInput = {
  id?: string | null;
  site_code: string;
  allocation_station_code: string;
  parent_station_code?: string | null;
  region?: string | null;
  payee_name: string;
  monthly_rent: string;
  monthly_maintenance: string;
  effective_from: string;
  effective_to?: string | null;
  change_reason: string;
  expected_updated_at?: string | null;
};

export type RentRecord = RentInput & {
  id: string;
  source_file: string | null;
  source_sheet: string | null;
  source_row: number | null;
  created_at: string;
  updated_at: string;
};

const code = /^[A-Z0-9_-]{1,40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDate(value: string) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function money(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{1,12}(\.\d{1,2})?$/.test(value.trim()))
    throw new Error(`${label} must be a non-negative amount with up to 2 decimals.`);
  return value.trim();
}

export function validateRent(value: unknown): RentInput {
  if (!value || typeof value !== "object") throw new Error("Invalid rent record.");
  const input = value as RentInput;
  const site = String(input.site_code ?? "").trim().toUpperCase();
  const allocation = String(input.allocation_station_code ?? "")
    .trim()
    .toUpperCase();
  const parent = String(input.parent_station_code ?? "").trim().toUpperCase();
  const payee = String(input.payee_name ?? "").trim();
  const region = String(input.region ?? "").trim();
  const reason = String(input.change_reason ?? "").trim();
  const effectiveFrom = String(input.effective_from ?? "").trim();
  const effectiveTo = String(input.effective_to ?? "").trim();
  const monthlyRent = money(input.monthly_rent, "Monthly rent");
  const maintenance = money(input.monthly_maintenance, "Monthly maintenance");

  if (!code.test(site)) throw new Error("Enter a valid premise or site code.");
  if (!code.test(allocation)) throw new Error("Choose a valid cost allocation.");
  if (parent && !code.test(parent)) throw new Error("Enter a valid parent station code.");
  if (!payee || payee.length > 160) throw new Error("Enter the payee or landlord name (up to 160 characters).");
  if (region.length > 100) throw new Error("Region must be 100 characters or fewer.");
  if (!validDate(effectiveFrom)) throw new Error("Choose a valid effective-from date.");
  if (effectiveTo && (!validDate(effectiveTo) || effectiveTo < effectiveFrom))
    throw new Error("Effective-through date must be on or after the start date.");
  if (!reason || reason.length > 500) throw new Error("Add a change reason (up to 500 characters).");
  if (decimal(monthlyRent) + decimal(maintenance) <= BigInt(0))
    throw new Error("Rent plus maintenance must be greater than zero.");

  const id = input.id ? String(input.id) : null;
  if (id && !uuid.test(id)) throw new Error("Invalid rent record ID.");
  const expected = input.expected_updated_at
    ? String(input.expected_updated_at)
    : null;
  if (id && (!expected || Number.isNaN(new Date(expected).valueOf())))
    throw new Error("Refresh this rent record before editing it.");

  return {
    id,
    site_code: site,
    allocation_station_code: allocation,
    parent_station_code: parent || null,
    region: region || null,
    payee_name: payee,
    monthly_rent: monthlyRent,
    monthly_maintenance: maintenance,
    effective_from: effectiveFrom,
    effective_to: effectiveTo || null,
    change_reason: reason,
    expected_updated_at: expected,
  };
}

export function monthlyRentTotal(record: Pick<RentInput, "monthly_rent" | "monthly_maintenance">) {
  return addAmounts([record.monthly_rent, record.monthly_maintenance])!;
}

export function dailyRentAmount(monthly: string, day: number, daysInMonth: number) {
  return subtractAmounts(
    mgEstimate(monthly, day, daysInMonth),
    mgEstimate(monthly, day - 1, daysInMonth),
  );
}

export function rentPeriodStatus(record: Pick<RentInput, "effective_from" | "effective_to">, today: string) {
  if (record.effective_from > today) return "Upcoming";
  if (record.effective_to && record.effective_to < today) return "Ended";
  return "Active";
}
