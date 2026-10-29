// Kept as a tombstone for old clients; no reads, replies or recovery holds.
export const dynamic = "force-dynamic";
function retired() {
  return Response.json(
    { error: "Loss recovery clarification is no longer available." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
export const GET = retired;
export const POST = retired;
