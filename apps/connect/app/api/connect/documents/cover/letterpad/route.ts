import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { createInsuranceCoverLetterpadPdf } from "@/lib/insurance-letterpad";
import { userFacingError } from "@/lib/user-facing-error";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

type PersonRow = {
  full_name?: string | null;
  pan_number?: string | null;
  employee_code?: string | null;
  dropx_id?: string | null;
};

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor" && profileType !== "workforce") {
      return Response.json({ error: "Account is invalid." }, { status: 400 });
    }
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);

    let personData: PersonRow | null = null;
    if (profileType === "employee") {
      const person = await supabaseAdmin
        .from("employees")
        .select("full_name,pan_number,employee_code")
        .eq("company_id", account.companyId)
        .eq("id", account.id)
        .maybeSingle();
      if (person.error) throw new Error(person.error.message);
      personData = person.data;
    } else if (profileType === "contractor") {
      const person = await supabaseAdmin
        .from("contractors")
        .select("full_name,pan_number,dropx_id")
        .eq("company_id", account.companyId)
        .eq("id", account.id)
        .maybeSingle();
      if (person.error) throw new Error(person.error.message);
      personData = person.data;
    } else {
      const person = await supabaseAdmin
        .from("workforce")
        .select("full_name,pan_number")
        .eq("company_id", account.companyId)
        .eq("id", account.id)
        .maybeSingle();
      if (person.error) throw new Error(person.error.message);
      personData = person.data;
    }
    if (!personData) throw new Error("Profile was not found.");

    const [members, cards] = await Promise.all([
      supabaseAdmin
        .from("insurance_covered_members")
        .select("full_name,relationship_type,membership_no,policy_type,valid_to")
        .eq("company_id", account.companyId)
        .eq("profile_type", profileType)
        .eq("profile_id", account.id)
        .order("policy_type")
        .order("relationship_type"),
      supabaseAdmin
        .from("connect_insurance_cards")
        .select("policy_number,insurer_name,valid_to,policy_type")
        .eq("company_id", account.companyId)
        .eq("profile_type", profileType)
        .eq("profile_id", account.id)
    ]);

    const gmc = (cards.data ?? []).find((row) => String(row.policy_type).toUpperCase() === "GMC") ?? (cards.data ?? [])[0];
    const primaryName = String(personData.full_name || "Associate");
    const workerCode =
      profileType === "employee"
        ? String(personData.employee_code || "")
        : profileType === "contractor"
          ? String(personData.dropx_id || "")
          : null;
    const rows = members.error ? [] : members.data ?? [];
    const bytes = await createInsuranceCoverLetterpadPdf({
      primaryName,
      pan: String(personData.pan_number || ""),
      workerCode: workerCode || null,
      policyNumber: gmc?.policy_number ?? null,
      insurerName: gmc?.insurer_name ?? "Marsh / Qover",
      validTo: gmc?.valid_to ?? null,
      members: rows.length
        ? rows.map((row) => ({
            fullName: row.full_name,
            relationshipType: row.relationship_type || "Self",
            membershipNo: row.membership_no,
            policyType: row.policy_type,
            validTo: row.valid_to
          }))
        : [{ fullName: primaryName, relationshipType: "Self", policyType: gmc?.policy_type ?? "GMC" }]
    });

    const stem = (workerCode || primaryName).replace(/[^a-zA-Z0-9._-]+/g, "-") || "cover";
    return new Response(Buffer.from(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${stem}_group-insurance-cover.pdf"`,
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return Response.json({ error: userFacingError(error, "Unable to open the group insurance cover letter.") }, { status: 400 });
  }
}
