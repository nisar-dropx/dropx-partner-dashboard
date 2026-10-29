import {
  approveLossRecovery,
  transitionLossLifecycle,
} from "@/lib/ops-pulse/nl-loss-lifecycle";
import { getAuthorization, hasPermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return reply({ error: "Invalid request origin." }, 403);
    }
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth, "ops_losses", "access")) {
      return reply({ error: "Access denied." }, 403);
    }
    const body = await request.json();
    const month = String(body.month || "");
    const caseKey = String(body.case_key || body.caseKey || "");
    const action = String(body.action || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !caseKey || !action) {
      return reply({ error: "Invalid lifecycle request." }, 400);
    }

    if (action === "approve") {
      if (!Number.isInteger(body.version) || !Number.isInteger(body.lifecycle_version)) {
        return reply({ error: "Version is required." }, 400);
      }
      const data = await approveLossRecovery({
        auth,
        month,
        caseKey,
        version: body.version,
        lifecycleVersion: body.lifecycle_version,
        note: body.note ?? null,
      });
      return reply({ ok: true, recovery: data });
    }

    if (action === "clarify") {
      return reply({ error: "Loss recovery clarification is no longer available." }, 410);
    }

    if (!Number.isInteger(body.version)) {
      return reply({ error: "Version is required." }, 400);
    }
    const data = await transitionLossLifecycle({
      auth,
      month,
      caseKey,
      action,
      version: body.version,
      note: body.note ?? null,
    });
    return reply({ ok: true, case: data });
  } catch (e) {
    return reply(
      { error: e instanceof Error ? e.message : "Unable to update loss lifecycle." },
      403,
    );
  }
}
