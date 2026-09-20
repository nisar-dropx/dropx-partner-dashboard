import { supabaseAdmin } from "@/lib/supabase-admin";

export type WorkforceContactRegister =
  | "workforce"
  | "employees"
  | "contractors"
  | "helpers"
  | "vendors"
  | "workers";

export type WorkforceContactMatch = {
  id: string;
  register: WorkforceContactRegister;
  fullName: string;
  code: string;
};

export type WorkforceContactFieldStatus = {
  status: "idle" | "checking" | "available" | "taken" | "invalid";
  message: string;
  match: WorkforceContactMatch | null;
};

const CONTACT_REGISTERS: Array<{
  register: WorkforceContactRegister;
  codeColumn: "dropx_id" | "employee_code";
}> = [
  { register: "workforce", codeColumn: "dropx_id" },
  { register: "employees", codeColumn: "employee_code" },
  { register: "contractors", codeColumn: "dropx_id" },
  { register: "helpers", codeColumn: "dropx_id" },
  { register: "vendors", codeColumn: "dropx_id" },
  { register: "workers", codeColumn: "dropx_id" }
];

function cleanMobile(value: string) {
  return String(value ?? "").replace(/\D/g, "");
}

function cleanEmail(value: string) {
  return String(value ?? "").trim().toLowerCase();
}

function registerLabel(register: WorkforceContactRegister) {
  if (register === "employees") return "Employees";
  if (register === "contractors") return "Independent Contractors";
  if (register === "helpers") return "Helpers";
  if (register === "vendors") return "Vendors";
  if (register === "workers") return "Workers";
  return "Workforce";
}

function matchLabel(match: WorkforceContactMatch) {
  const who = match.fullName || "an existing profile";
  const code = match.code ? ` · ${match.code}` : "";
  return `${who}${code} in ${registerLabel(match.register)}`;
}

async function findMatches(params: {
  companyId: string;
  column: "mobile" | "email";
  value: string;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const matches: WorkforceContactMatch[] = [];

  for (const item of CONTACT_REGISTERS) {
    let query = supabaseAdmin
      .from(item.register)
      .select(`id, full_name, ${item.codeColumn}`)
      .eq("company_id", params.companyId)
      .limit(5);

    query = params.column === "email"
      ? query.ilike("email", params.value)
      : query.eq("mobile", params.value);

    const result = await query;
    if (result.error) {
      if (/does not exist|schema cache|relation/i.test(result.error.message)) continue;
      throw new Error(result.error.message);
    }

    for (const row of result.data ?? []) {
      const id = String(row.id ?? "");
      if (!id) continue;
      if (
        params.excludeId
        && params.excludeRegister === item.register
        && id === params.excludeId
      ) {
        continue;
      }
      matches.push({
        id,
        register: item.register,
        fullName: String(row.full_name ?? "").trim() || "Existing profile",
        code: String((row as Record<string, unknown>)[item.codeColumn] ?? "").trim()
      });
    }
  }

  return matches;
}

export async function checkWorkforceMobileAvailability(params: {
  companyId: string;
  mobile: string;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
}): Promise<WorkforceContactFieldStatus> {
  const mobile = cleanMobile(params.mobile);
  if (!/^\d{10}$/.test(mobile)) {
    return { status: "invalid", message: "Enter a 10-digit mobile number.", match: null };
  }
  const matches = await findMatches({
    companyId: params.companyId,
    column: "mobile",
    value: mobile,
    excludeId: params.excludeId,
    excludeRegister: params.excludeRegister
  });
  if (matches.length) {
    return {
      status: "taken",
      message: `Already registered to ${matchLabel(matches[0])}.`,
      match: matches[0]
    };
  }
  return { status: "available", message: "Mobile number is available.", match: null };
}

export async function checkWorkforceEmailAvailability(params: {
  companyId: string;
  email: string;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
}): Promise<WorkforceContactFieldStatus> {
  const email = cleanEmail(params.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: "invalid", message: "Enter a valid email address.", match: null };
  }
  const matches = await findMatches({
    companyId: params.companyId,
    column: "email",
    value: email,
    excludeId: params.excludeId,
    excludeRegister: params.excludeRegister
  });
  if (matches.length) {
    return {
      status: "taken",
      message: `Already registered to ${matchLabel(matches[0])}.`,
      match: matches[0]
    };
  }
  return { status: "available", message: "Email is available.", match: null };
}

export async function assertWorkforceContactsAvailable(params: {
  companyId: string;
  mobile: string;
  email: string;
  excludeId?: string | null;
  excludeRegister?: WorkforceContactRegister | null;
}) {
  const [mobileStatus, emailStatus] = await Promise.all([
    checkWorkforceMobileAvailability(params),
    checkWorkforceEmailAvailability(params)
  ]);
  if (mobileStatus.status === "taken") throw new Error(mobileStatus.message);
  if (mobileStatus.status === "invalid") throw new Error(mobileStatus.message);
  if (emailStatus.status === "taken") throw new Error(emailStatus.message);
  if (emailStatus.status === "invalid") throw new Error(emailStatus.message);
}
