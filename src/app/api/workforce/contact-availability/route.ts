import { NextRequest, NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  checkWorkforceEmailAvailability,
  checkWorkforceMobileAvailability,
  type WorkforceContactRegister
} from "@/lib/workforce-contact-availability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_CODES = ["delivery_associates", "contractors", "vendors", "workers"] as const;
const REGISTERS = new Set<WorkforceContactRegister>([
  "workforce",
  "employees",
  "contractors",
  "helpers",
  "vendors",
  "workers"
]);

function canAccessWorkforceContacts(authorization: NonNullable<Awaited<ReturnType<typeof getAuthorization>>>) {
  return PAGE_CODES.some((pageCode) => hasPermission(authorization, pageCode, "access"));
}

export async function GET(request: NextRequest) {
  const authorization = await getAuthorization();
  if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
  if (!canAccessWorkforceContacts(authorization)) {
    return NextResponse.json({ error: "You do not have access to check workforce contacts." }, { status: 403 });
  }

  const companyId = requireCompanyId(authorization);
  const mobile = String(request.nextUrl.searchParams.get("mobile") ?? "").trim();
  const email = String(request.nextUrl.searchParams.get("email") ?? "").trim();
  const excludeId = String(request.nextUrl.searchParams.get("excludeId") ?? "").trim() || null;
  const excludeRegisterValue = String(request.nextUrl.searchParams.get("excludeRegister") ?? "").trim();
  const excludeRegister = REGISTERS.has(excludeRegisterValue as WorkforceContactRegister)
    ? excludeRegisterValue as WorkforceContactRegister
    : null;

  if (!mobile && !email) {
    return NextResponse.json({ error: "Provide a mobile number or email to check." }, { status: 400 });
  }

  try {
    const [mobileStatus, emailStatus] = await Promise.all([
      mobile
        ? checkWorkforceMobileAvailability({ companyId, mobile, excludeId, excludeRegister })
        : Promise.resolve(null),
      email
        ? checkWorkforceEmailAvailability({ companyId, email, excludeId, excludeRegister })
        : Promise.resolve(null)
    ]);
    return NextResponse.json({ mobile: mobileStatus, email: emailStatus });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to check contact availability."
    }, { status: 500 });
  }
}
