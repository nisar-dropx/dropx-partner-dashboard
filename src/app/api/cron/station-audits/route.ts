export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ disabled: true, message: "Station audits are scheduled by configured audit managers; no automatic programme is created." });
}
