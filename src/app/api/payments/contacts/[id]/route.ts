import { NextRequest, NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    if (!hasPermission(authorization, "payment_requests", "add") && !hasPermission(authorization, "payment_requests", "edit")) {
      return NextResponse.json({ error: "Permission required." }, { status: 403 });
    }

    const companyId = requireCompanyId(authorization);
    const contactId = String(params.id ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
      return NextResponse.json({ error: "Invalid saved beneficiary." }, { status: 400 });
    }

    const existing = await supabaseAdmin
      .from("payment_contacts")
      .select("id, account_holder_name")
      .eq("company_id", companyId)
      .eq("created_by", authorization.userId)
      .eq("id", contactId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) return NextResponse.json({ error: "Saved beneficiary not found." }, { status: 404 });

    const removed = await supabaseAdmin
      .from("payment_contacts")
      .delete()
      .eq("company_id", companyId)
      .eq("created_by", authorization.userId)
      .eq("id", contactId)
      .select("id")
      .maybeSingle();
    if (removed.error) {
      if (removed.error.code === "23503") {
        return NextResponse.json({
          error: "This beneficiary is linked to a vendor contract and cannot be deleted."
        }, { status: 409 });
      }
      throw new Error(removed.error.message);
    }
    if (!removed.data) return NextResponse.json({ error: "Saved beneficiary not found." }, { status: 404 });

    return NextResponse.json({ ok: true, id: removed.data.id, accountHolderName: existing.data.account_holder_name });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to delete saved beneficiary."
    }, { status: 500 });
  }
}
