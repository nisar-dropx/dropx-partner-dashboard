import { requireConnectAccount } from "@/lib/connect-auth";
import { loadConnectPayAdvanceReviewDetails } from "@/lib/connect-pay-advance-approval-data";
import { userFacingError } from "@/lib/user-facing-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const params = new URL(request.url).searchParams;
    const profileType = params.get("profileType"), accountId = params.get("accountId"), requestId = params.get("requestId");
    if (!["user", "employee", "contractor"].includes(profileType ?? "") || !accountId || !requestId)
      return Response.json({ error: "Choose an account and advance request." }, { status: 400, headers });
    const account = await requireConnectAccount(profileType as "user" | "employee" | "contractor", accountId);
    return Response.json(await loadConnectPayAdvanceReviewDetails(account, requestId), { headers });
  } catch (error) {
    return Response.json({ error: userFacingError(error, "Advance review details could not be loaded. Please retry.") }, { status: 403, headers });
  }
}
