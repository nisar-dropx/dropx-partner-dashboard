"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { booksContext } from "@/lib/finance360/server";
import {
  ACCOUNT_TYPES,
  date,
  decimal,
  paise,
  parseBank,
  parseJournals,
  type SheetRow,
} from "@/lib/finance360/model";

function field(data: FormData, key: string, max = 200, optional = false) {
  const v = String(data.get(key) ?? "").trim();
  if ((!v && !optional) || v.length > max)
    throw new Error(
      `${key.replaceAll("_", " ")} is required, up to ${max} characters.`,
    );
  return v;
}
function uuid(data: FormData, key: string) {
  const v = field(data, key);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    throw new Error(`Select a valid ${key}.`);
  return v;
}
export async function saveBooks(
  data: FormData,
): Promise<{ ok: boolean; message: string }> {
  const action = String(data.get("action"));
  // Authentication is evaluated outside the error handler so redirects retain their semantics.
  const ctx = await booksContext(
    ["match", "unmatch", "reversal", "lock", "coverage"].includes(action)
      ? "edit"
      : "add",
  );
  try {
    if (data.get("confirmed") !== "yes")
      throw new Error("Review the details and confirm before saving.");
    let payload: Record<string, unknown> = {};
    const rows = () => {
      const raw = field(data, "rows", 700000);
      const result: unknown = JSON.parse(raw);
      if (
        !Array.isArray(result) ||
        result.some((r) => !r || typeof r !== "object" || Array.isArray(r))
      )
        throw new Error("Invalid spreadsheet rows.");
      return result as SheetRow[];
    };
    if (action === "journal") payload = { vouchers: parseJournals(rows()) };
    else if (action === "manual") payload = { vouchers: parseJournals(rows()) };
    else if (action === "account") {
      const type = field(data, "type");
      if (!(ACCOUNT_TYPES as readonly string[]).includes(type))
        throw new Error("Select an account type.");
      payload = {
        code: field(data, "code", 80),
        name: field(data, "name"),
        type,
      };
    } else if (action === "bank") {
      const start = date(field(data, "start")),
        end = date(field(data, "end"));
      const opening = decimal(paise(field(data, "opening"), true)),
        closing = decimal(paise(field(data, "closing"), true));
      payload = {
        account_code: field(data, "account_code", 80),
        start,
        end,
        opening,
        closing,
        rows: parseBank(rows(), opening, closing, start, end),
      };
    } else if (action === "loan") {
      const next = field(data, "next_due", 10, true);
      payload = {
        account_code: field(data, "account_code", 80),
        facility: field(data, "facility"),
        lender: field(data, "lender"),
        as_of: date(field(data, "as_of")),
        principal: decimal(paise(field(data, "principal"))),
        interest_due: decimal(paise(field(data, "interest_due"))),
        emi: decimal(paise(field(data, "emi"))),
        next_due: next ? date(next) : null,
        note: field(data, "note", 1000),
      };
    } else if (action === "reversal")
      payload = {
        journal_id: uuid(data, "journal_id"),
        date: date(field(data, "date")),
        reference: field(data, "reference", 150),
        narration: field(data, "narration", 1000),
      };
    else if (action === "match")
      payload = {
        row_id: uuid(data, "row_id"),
        line_id: uuid(data, "line_id"),
      };
    else if (action === "unmatch")
      payload = {
        row_id: uuid(data, "row_id"),
        reason: field(data, "reason", 1000),
      };
    else if (action === "lock")
      payload = {
        date: date(field(data, "date")),
        reason: field(data, "reason", 1000),
      };
    else if (action === "coverage") {
      const start = date(field(data, "start")),
        end = date(field(data, "end"));
      if (start > end) throw new Error("Invalid coverage dates.");
      payload = { start, end, reason: field(data, "reason", 1000) };
    } else throw new Error("Unknown accounting action.");
    const hash = createHash("sha256")
      .update(JSON.stringify({ action, ...payload }))
      .digest("hex");
    payload = {
      ...payload,
      sha256: hash,
      filename: field(data, "filename", 200, true) || `${action} entry`,
    };
    const { error } = await ctx.db.rpc("finance360_write", {
      p_company: ctx.companyId,
      p_actor: ctx.authorization.userId,
      p_action: action,
      p_data: payload,
    });
    if (error) {
      if (error.code === "23505")
        throw new Error(
          "This file, voucher reference, account or statement already exists. Nothing was saved twice.",
        );
      if (error.code === "P0001") throw new Error(error.message);
      if (error.code === "23503" || error.code === "P0002")
        throw new Error(
          "The selected account or record could not be found in your company.",
        );
      console.error("Finance accounting write failed", {
        code: error.code,
        action,
      });
      throw new Error(
        "Unable to save this entry. No partial import was saved. Please retry.",
      );
    }
    revalidatePath("/finance/books");
    return {
      ok: true,
      message:
        action === "journal" || action === "manual"
          ? "Balanced vouchers posted. The books and reports have been updated."
          : "Saved. The workspace has been updated.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Unable to save. Please retry.",
    };
  }
}

export async function bankCandidates(
  rowId: string,
): Promise<{
  error: string;
  rows: import("@/lib/finance360/types").Candidate[];
}> {
  const ctx = await booksContext();
  if (!/^[0-9a-f-]{36}$/i.test(rowId))
    return { error: "Invalid transaction.", rows: [] };
  const result = await ctx.db.rpc("finance360_candidates", {
    p_company: ctx.companyId,
    p_row: rowId,
  });
  if (result.error)
    return {
      error: "Unable to load matching book entries. Please retry.",
      rows: [],
    };
  return { error: "", rows: result.data ?? [] };
}
