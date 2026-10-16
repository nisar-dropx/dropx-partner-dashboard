import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { booksContext } from "@/lib/finance360/server";
import { hasPermission, isCompanyOwner } from "@/lib/authorization";
import { parseBank, date, decimal, paise } from "@/lib/finance360/model";
import { accountKey, bankLedgerCode } from "@/lib/finance/treasury/model";
import {
  ACCOUNTING_COMPANY,
  accountingConfigured,
  accountingRequest,
} from "@/lib/finance/accounting-sync/client";
import { accountingConsole } from "@/lib/finance/accounting-sync/console";
import {
  paymentCandidates,
  preparePaymentPlan,
  validatePaymentPlan,
  paymentChecklist,
} from "@/lib/finance/accounting-sync/payments";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers });
type Params = { params: { action: string } };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const workflowActions = new Set([
  "catalog",
  "evidence",
  "draft",
  "decision",
  "backup",
  "issue",
  "verify",
  "payment-plan",
  "stage",
]);

export async function GET(request: Request, { params }: Params) {
  const ctx = await booksContext();
  if (ctx.companyId !== ACCOUNTING_COMPANY)
    return json({ error: "Company not configured." }, 403);
  if (params.action === "console")
    return new Response(accountingConsole, {
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  try {
    if (["workflow", "candidates", "package", "plan"].includes(params.action)) {
      if (!isCompanyOwner(ctx.authorization) || ctx.authorization.readOnly)
        return json({ error: "Company owner access is required." }, 403);
      if (params.action === "candidates")
        return json(await paymentCandidates(ctx));
      if (params.action === "workflow")
        return json(
          await accountingRequest(
            ctx.companyId,
            ctx.authorization.userId,
            "/v1/workflow",
          ),
        );
      const id = new URL(request.url).searchParams.get("id");
      if (
        !id ||
        (params.action === "plan" ? !validId(id) : !/^[a-f0-9-]{36}$/i.test(id))
      )
        return json({ error: "Invalid document." }, 400);
      const result = await accountingRequest(
        ctx.companyId,
        ctx.authorization.userId,
        `/v1/${params.action}?id=${id}`,
      );
      if (params.action === "plan") {
        await validatePaymentPlan(ctx, result);
        return new Response(paymentChecklist(result), {
          headers: {
            ...headers,
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="payment-review-${id.slice(0, 12)}.xlsx"`,
          },
        });
      }
      return new Response(result.xml, {
        headers: {
          ...headers,
          "Content-Type": "application/xml; charset=utf-8",
          "Content-Disposition": `attachment; filename="fin-tally-${id}.xml"`,
        },
      });
    }
    if (params.action === "status") {
      const banks = await ctx.db
        .from("payment_banks")
        .select("id,display_name,account_no")
        .eq("company_id", ctx.companyId)
        .eq("is_active", true)
        .eq("bank_code", "FEDERAL_BANK");
      if (banks.error)
        throw Error("Unable to load configured Federal Bank accounts.");
      return json({
        configured: accountingConfigured(),
        owner: isCompanyOwner(ctx.authorization) && !ctx.authorization.readOnly,
        canImport:
          hasPermission(ctx.authorization, "finance_books", "add") &&
          !ctx.authorization.readOnly,
        banks: (banks.data ?? []).map((b) => ({
          id: b.id,
          name: b.display_name,
          last4: String(b.account_no).slice(-4),
        })),
        ...(accountingConfigured()
          ? await accountingRequest(
              ctx.companyId,
              ctx.authorization.userId,
              "/v1/status",
            )
          : { snapshots: [], events: [] }),
      });
    }
    if (params.action === "preview") {
      const id = new URL(request.url).searchParams.get("id");
      if (!validId(id)) return json({ error: "Invalid snapshot." }, 400);
      const snapshot = await accountingRequest(
        ctx.companyId,
        ctx.authorization.userId,
        `/v1/snapshot?id=${id}`,
      );
      const { account, ...safe } = snapshot;
      return json({ ...safe, accountLast4: String(account).slice(-4) });
    }
    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json(
      {
        error:
          e instanceof Error ? e.message : "Unable to load accounting sync.",
      },
      503,
    );
  }
}

export async function POST(request: Request, { params }: Params) {
  const ctx = await booksContext();
  if (ctx.companyId !== ACCOUNTING_COMPANY || ctx.authorization.readOnly)
    return json({ error: "Permission required." }, 403);
  // Session controls expose interactive bank/Tally access: restrict to the company
  // owner, not every role that can view financial reports.
  if (
    (["session", "collect"].includes(params.action) ||
      workflowActions.has(params.action)) &&
    !isCompanyOwner(ctx.authorization)
  )
    return json(
      {
        error:
          "Company owner access is required for browser and posting controls.",
      },
      403,
    );
  if (
    params.action === "import" &&
    !hasPermission(ctx.authorization, "finance_books", "add")
  )
    return json({ error: "Accounting import permission required." }, 403);
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    return json({ error: "Same-origin request required." }, 403);
  try {
    const raw = await request.text();
    if (
      new TextEncoder().encode(raw).length >
      (["catalog", "evidence"].includes(params.action) ? 4000000 : 50000)
    )
      return json({ error: "Request too large." }, 413);
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input))
      return json({ error: "Invalid request." }, 400);
    if (workflowActions.has(params.action)) {
      const body =
        params.action === "payment-plan"
          ? await preparePaymentPlan(ctx, input)
          : input;
      return json(
        await accountingRequest(
          ctx.companyId,
          ctx.authorization.userId,
          `/v1/${params.action}`,
          body,
        ),
      );
    }
    if (params.action === "session" || params.action === "collect") {
      if (!["fednet", "cocloud"].includes(input.provider))
        return json({ error: "Choose FedNet or CoCloud." }, 400);
      let allowedAccounts: string[] = [];
      if (params.action === "collect" && input.provider === "fednet") {
        const banks = await ctx.db
          .from("payment_banks")
          .select("account_no")
          .eq("company_id", ctx.companyId)
          .eq("is_active", true)
          .eq("bank_code", "FEDERAL_BANK");
        if (banks.error)
          throw Error("Unable to verify bank account ownership.");
        allowedAccounts = (banks.data ?? []).map((b) =>
          accountKey(b.account_no),
        );
      }
      const result = await accountingRequest(
        ctx.companyId,
        ctx.authorization.userId,
        `/v1/${params.action}`,
        { provider: input.provider, allowedAccounts },
      );
      if (
        result.liveView &&
        new URL(result.liveView).origin !== "https://live.browser.run"
      )
        throw Error("Unexpected browser session link.");
      return json(result);
    }
    if (params.action !== "import") return json({ error: "Not found." }, 404);
    if (
      !validId(input.id) ||
      input.confirmed !== true ||
      !/^[a-f0-9-]{36}$/i.test(input.bankId ?? "")
    )
      return json(
        { error: "Review the statement and select its bank before importing." },
        400,
      );
    const snapshot = await accountingRequest(
      ctx.companyId,
      ctx.authorization.userId,
      `/v1/snapshot?id=${input.id}`,
    );
    const bank = await ctx.db
      .from("payment_banks")
      .select("id,account_no")
      .eq("company_id", ctx.companyId)
      .eq("id", input.bankId)
      .eq("is_active", true)
      .eq("bank_code", "FEDERAL_BANK")
      .single();
    if (
      bank.error ||
      !bank.data ||
      accountKey(bank.data.account_no) !== accountKey(snapshot.account)
    )
      throw Error("Statement does not belong to the selected bank account.");
    const code = bankLedgerCode(
      bank.data.id,
      createHash("sha256")
        .update(accountKey(bank.data.account_no))
        .digest("hex"),
    );
    const account = await ctx.db
      .from("finance360_accounts")
      .select("code")
      .eq("company_id", ctx.companyId)
      .eq("code", code)
      .single();
    if (account.error || !account.data)
      throw Error(
        "Enable statement imports for this bank in Cash & reconciliation first.",
      );
    const start = date(snapshot.start),
      end = date(snapshot.end),
      opening = decimal(paise(snapshot.opening, true)),
      closing = decimal(paise(snapshot.closing, true));
    const payload = {
      account_code: code,
      start,
      end,
      opening,
      closing,
      rows: parseBank(snapshot.rows, opening, closing, start, end),
    };
    const sha256 = createHash("sha256")
      .update(JSON.stringify({ action: "bank", ...payload }))
      .digest("hex");
    const result = await ctx.db.rpc("finance360_write", {
      p_company: ctx.companyId,
      p_actor: ctx.authorization.userId,
      p_action: "bank",
      p_data: {
        ...payload,
        sha256,
        filename: `FedNet HTML ${start} to ${end}`,
      },
    });
    if (result.error) {
      if (result.error.code === "23505")
        return json(
          {
            error:
              "This statement is already imported. No duplicate was saved.",
          },
          409,
        );
      if (result.error.code === "P0001")
        return json({ error: result.error.message }, 409);
      throw Error("Statement import failed. No partial import was saved.");
    }
    revalidatePath("/finance/treasury");
    revalidatePath("/finance/books");
    return json({
      message:
        "Statement imported. Review its matches in Cash & reconciliation. No payments or Tally vouchers were created.",
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Accounting sync failed." },
      422,
    );
  }
}
