import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const fields = "id, source_code, name, description, file_types, day_offset, upload_time, frequency, weekday, parser_type, dedupe_fields, is_active, requires_station, station_scope, requires_report_date, report_date_label, date_default_offset";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function context() {
  if (!supabaseAdmin) throw new Error("Supabase service key is not configured.");
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Login required.");
  return { authorization, companyId: requireCompanyId(authorization), db: supabaseAdmin };
}

function payload(body: Record<string, unknown>) {
  const frequency = clean(body.frequency);
  const fileTypes = Array.isArray(body.file_types) ? body.file_types.map(clean).filter(Boolean) : clean(body.file_types).split(",").map(clean).filter(Boolean);
  const dedupeFields = Array.isArray(body.dedupe_fields) ? body.dedupe_fields.map(clean).filter(Boolean) : clean(body.dedupe_fields).split(",").map(clean).filter(Boolean);
  return {
    source_code: clean(body.source_code).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    name: clean(body.name),
    description: clean(body.description) || null,
    file_types: fileTypes.map((item) => item.toLowerCase().replace(/^\./, "")),
    day_offset: Number(body.day_offset ?? 0),
    upload_time: clean(body.upload_time) || null,
    frequency,
    weekday: frequency === "weekly" && body.weekday !== null && body.weekday !== "" ? Number(body.weekday) : null,
    parser_type: clean(body.parser_type),
    dedupe_fields: dedupeFields,
    is_active: body.is_active !== false,
    requires_station: body.requires_station === true,
    station_scope: body.requires_station === true ? clean(body.station_scope) || "all" : "none",
    requires_report_date: body.requires_report_date === true,
    report_date_label: body.requires_report_date === true ? clean(body.report_date_label) || "Data date" : null,
    date_default_offset: body.requires_report_date === true ? Number(body.date_default_offset ?? 0) : 0
  };
}

export async function GET() {
  try {
    const { authorization, companyId, db } = await context();
    if (!hasPermission(authorization, "imports", "access")) return Response.json({ error: "Permission denied." }, { status: 403 });
    const { data, error } = await db.from("report_import_master").select(fields).eq("company_id", companyId).neq("parser_type", "performance_target").order("name");
    if (error) throw error;
    return Response.json({ reports: (data ?? []).filter((report) => Array.isArray(report.file_types) && report.file_types.length > 0) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load import master." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const { authorization, companyId, db } = await context();
    if (!hasPermission(authorization, "imports", "add")) return Response.json({ error: "Permission denied." }, { status: 403 });
    const values = payload(await request.json());
    if(values.parser_type==="performance_station_target"||values.source_code.startsWith("perf_station_review_"))return Response.json({error:"Use Performance Master to configure station targets."},{status:403});
    if (!values.source_code || !values.name || !values.parser_type || !values.file_types.length) {
      return Response.json({ error: "Name, source code, parser and file type are required." }, { status: 400 });
    }
    const { data, error } = await db.from("report_import_master").insert({
      ...values, company_id: companyId, created_by: authorization.userId
    }).select(fields).single();
    if (error) throw error;
    return Response.json({ report: data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to create report." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { authorization, companyId, db } = await context();
    if (!hasPermission(authorization, "imports", "edit")) return Response.json({ error: "Permission denied." }, { status: 403 });
    const body = await request.json();
    if(clean(body.parser_type)==="performance_station_target"||clean(body.source_code).startsWith("perf_station_review_"))return Response.json({error:"Use Performance Master to configure station targets."},{status:403});
    const id = clean(body.id);
    const { data, error } = await db.from("report_import_master").update({
      ...payload(body), updated_at: new Date().toISOString()
    }).eq("id", id).eq("company_id", companyId).neq("parser_type","performance_station_target").select(fields).single();
    if (error) throw error;
    return Response.json({ report: data });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to update report." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { authorization, companyId, db } = await context();
    if (!hasPermission(authorization, "imports", "edit")) return Response.json({ error: "Permission denied." }, { status: 403 });
    const id = clean(new URL(request.url).searchParams.get("id"));
    const { error } = await db.from("report_import_master").delete().eq("id", id).eq("company_id", companyId).neq("parser_type","performance_station_target");
    if (error) throw error;
    return Response.json({ deleted: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to delete report." }, { status: 400 });
  }
}
