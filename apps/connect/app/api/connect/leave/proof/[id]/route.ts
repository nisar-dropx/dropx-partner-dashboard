import { requireConnectAccount, type ConnectAccount } from "../../../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clean(value: unknown) { return String(value ?? "").trim(); }
function safeDownloadName(value: string) { return value.replace(/[\r\n"]/g, "_") || "medical-proof"; }

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    if (!/^[0-9a-f-]{36}$/i.test(params.id)) return Response.json({ error: "Leave request is invalid." }, { status: 400 });
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor") return Response.json({ error: "Account is invalid." }, { status: 400 });
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const workerColumn = profileType === "employee" ? "employee_id" : "contractor_id";
    const result = await supabaseAdmin.from("hr_leave_requests")
      .select("proof_path,proof_file_name,proof_mime_type")
      .eq("company_id", account.companyId).eq("id", params.id).eq(workerColumn, account.id).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data?.proof_path) return Response.json({ error: "Medical proof was not found." }, { status: 404 });
    const download = await supabaseAdmin.storage.from("employee-profile-documents").download(result.data.proof_path);
    if (download.error) throw new Error(download.error.message);
    return new Response(await download.data.arrayBuffer(), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeDownloadName(result.data.proof_file_name || "medical-proof")}"`,
        "Content-Type": result.data.proof_mime_type || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to download medical proof." }, { status: 400 });
  }
}
