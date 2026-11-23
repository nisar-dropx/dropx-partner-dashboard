import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseWorkforceAdvanceWorkbook } from "@/lib/workforce-advance-import";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: "Sign in to upload advances." }, { status: 401 });
  if (!auth.companyId || !hasPermission(auth, "payment_process", "add") || auth.isPreview || auth.readOnly)
    return Response.json({ error: "Add access to Payment Process is required." }, { status: 403 });
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    const body = await request.formData();
    const file = body.get("file");
    const mode = body.get("mode");
    if (!(file instanceof File) || !/\.(xlsx|xls|csv)$/i.test(file.name) || file.size > 5 * 1024 * 1024)
      return Response.json({ error: "Choose an Excel or CSV file up to 5 MB." }, { status: 400 });
    if (mode !== "preview" && mode !== "commit") return Response.json({ error: "Invalid upload action." }, { status: 400 });
    const parsed = parseWorkforceAdvanceWorkbook(new Uint8Array(await file.arrayBuffer()));
    if (parsed.rows.length > 500) return Response.json({ error: "Upload at most 500 advances at a time." }, { status: 400 });
    if (!parsed.canCommit) return Response.json({ totalRows: parsed.rows.length, issues: parsed.issues, canCommit: false });
    const { data, error } = await supabaseAdmin.rpc("import_manually_paid_advances", {
      p_company: auth.companyId, p_actor: auth.userId, p_rows: parsed.rows,
      p_file_hash: parsed.fileSha256, p_locations: auth.hasAllLocationAccess ? null : auth.locationScopeIds,
      p_commit: mode === "commit"
    });
    if (error) throw new Error(error.message);
    return Response.json(data);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to upload advances." }, { status: 400 });
  }
}
