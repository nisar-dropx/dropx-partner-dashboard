import { supabaseAdmin } from "@/lib/supabase-admin";

function cleanEmail(value: string | null | undefined) {
  const text = String(value ?? "").trim().toLowerCase();
  return text && text.includes("@") ? text : null;
}

export function isBusinessDocumentCronOwner(request: Request, isVercel = process.env.VERCEL === "1") {
  if (!isVercel) return true;
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "dashboard.dropxlogistics.com" ||
    hostname === "admin-panel.dropxlogistics.com" ||
    (hostname.startsWith("dropx-partner-dashboard") && hostname.endsWith(".vercel.app"));
}

export async function loadComplianceManagerEmail(companyId: string) {
  if (!supabaseAdmin) return { email: null, error: "Supabase service role key is not configured." };

  const settings = await supabaseAdmin
    .from("business_document_settings")
    .select("compliance_manager_user_id")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (settings.error) return { email: null, error: settings.error.message };

  const userId = settings.data?.compliance_manager_user_id;
  if (!userId) return { email: null, error: null };

  const profile = await supabaseAdmin
    .from("profiles")
    .select("email")
    .eq("company_id", companyId)
    .eq("id", userId)
    .maybeSingle();
  if (profile.error) return { email: null, error: profile.error.message };

  return { email: cleanEmail(profile.data?.email), error: null };
}
