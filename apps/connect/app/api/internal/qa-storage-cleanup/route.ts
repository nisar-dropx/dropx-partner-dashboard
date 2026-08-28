import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cleanupToken = "b4954413-5d0c-4f81-8b7c-784a11cd0669-e46c562d";

const objects = [
  {
    bucket: "hr-expense-receipts",
    paths: [
      "43866344-b550-4e8a-9a2d-9d23f3d8a997/33eb9170-938e-4c8d-9702-a8138085a8ab/8ff7ab0d-37ca-4e80-9af3-4a7f8341984a/1787954069372-codex-clipboard-196cfb95-87f8-4812-be01-cad07e5233b9.png"
    ]
  },
  {
    bucket: "employee-profile-documents",
    paths: [
      "43866344-b550-4e8a-9a2d-9d23f3d8a997/issued/employee/b4ab0f8a-5129-41f1-9514-17aed1acaa41/insurance_card/1787957219690-39d7c3cc-fc04-4bdd-9189-b2383afa0afc-codex-clipboard-34e734d8-0694-47f1-995e-55654585e288.png"
    ]
  }
] as const;

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${cleanupToken}`) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database configuration is unavailable." }, { status: 503 });

  const removed: string[] = [];
  for (const object of objects) {
    const result = await supabaseAdmin.storage.from(object.bucket).remove([...object.paths]);
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    removed.push(...(result.data ?? []).map((item) => `${object.bucket}/${item.name}`));
  }

  return Response.json({ removed });
}
