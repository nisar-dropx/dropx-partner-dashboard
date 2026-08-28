import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cleanupToken = "921dd230-e7fb-4d6a-8427-87bc93f4f3d0-d6c322b5";
const paths = [
  "43866344-b550-4e8a-9a2d-9d23f3d8a997/b4ab0f8a-5129-41f1-9514-17aed1acaa41/attendance-regularization-2026-08-29-1787952877357.png",
  "43866344-b550-4e8a-9a2d-9d23f3d8a997/b4ab0f8a-5129-41f1-9514-17aed1acaa41/attendance-regularization-2026-08-29-1787952227533.png"
];

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${cleanupToken}`) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database configuration is unavailable." }, { status: 503 });

  const result = await supabaseAdmin.storage.from("employee-profile-documents").remove(paths);
  if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
  return Response.json({ removed: (result.data ?? []).map((item) => item.name) });
}
