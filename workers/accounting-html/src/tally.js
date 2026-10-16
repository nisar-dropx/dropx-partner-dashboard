import { XMLParser, XMLValidator } from "fast-xml-parser";
import { date, money, decimal, digest } from "./statement.js";

export const COMPANY = "DROPX 2026-27";
const array = (value) =>
  value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value) =>
  typeof value === "object"
    ? String(value?.["#text"] ?? "")
    : String(value ?? "");
export function parseXml(xml) {
  if (typeof xml !== "string" || new TextEncoder().encode(xml).length > 3000000)
    throw Error("Tally XML must be smaller than 3 MB.");
  // No external entities, custom DTDs, or ambiguous control characters.
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml)
  )
    throw Error("Unsupported Tally XML declarations or control characters.");
  if (XMLValidator.validate(xml) !== true) throw Error("Invalid Tally XML.");
  const result = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    maxNestedTags: 80,
  }).parse(xml);
  if (!result.ENVELOPE) throw Error("Tally export must contain an ENVELOPE.");
  return result;
}
function nodes(root, tag, found = [], depth = 0) {
  if (depth > 80) throw Error("Tally XML nesting limit exceeded.");
  if (!root || typeof root !== "object") return found;
  for (const [key, value] of Object.entries(root)) {
    if (key === tag) found.push(...array(value));
    else for (const child of array(value)) nodes(child, tag, found, depth + 1);
    if (found.length > 15000)
      throw Error("Tally export exceeds 15,000 records; use a smaller period.");
  }
  return found;
}
export function companyCheck(root, confirmedCompany) {
  if (confirmedCompany !== COMPANY)
    throw Error(`Select and confirm ${COMPANY} before uploading its export.`);
  const names = nodes(root, "SVCURRENTCOMPANY").map(text).filter(Boolean);
  if (names.some((name) => name !== COMPANY))
    throw Error("Tally export belongs to a different company.");
}
export async function catalog(xml, confirmedCompany) {
  const root = parseXml(xml);
  companyCheck(root, confirmedCompany);
  const ledgers = nodes(root, "LEDGER").map((l) => ({
    name: text(l["@_NAME"] || l.NAME),
    guid: text(l.GUID),
    parent: text(l.PARENT),
    billwise: text(l.ISBILLWISEON).toLowerCase() === "yes",
  }));
  if (!ledgers.length || ledgers.some((l) => !l.name || l.name.length > 200))
    throw Error("Export the Tally ledger masters as XML first.");
  if (new Set(ledgers.map((l) => l.name)).size !== ledgers.length)
    throw Error("Tally export contains duplicate ledger names.");
  return {
    company: COMPANY,
    ledgers,
    sha256: await digest(xml),
    capturedAt: new Date().toISOString(),
  };
}
function tallyDate(value) {
  const s = text(value);
  return date(
    /^\d{8}$/.test(s)
      ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
      : s,
  );
}
export async function daybook(xml, input) {
  const root = parseXml(xml);
  companyCheck(root, input.company);
  if (
    nodes(root, "IMPORTDATA").length ||
    nodes(root, "TALLYREQUEST").some((v) => /import/i.test(text(v)))
  )
    throw Error(
      "Tally import packages are not proof of posting. Upload a fresh Day Book export.",
    );
  const from = date(input.from),
    to = date(input.to);
  if (from > to) throw Error("Invalid Tally export period.");
  const vouchers = nodes(root, "VOUCHER").map((v) => {
    const entries = array(
      v["ALLLEDGERENTRIES.LIST"] ?? v["LEDGERENTRIES.LIST"],
    ).map((e) => ({
      ledger: text(e.LEDGERNAME),
      amount: decimal(money(text(e.AMOUNT))),
    }));
    if (
      !entries.length ||
      entries.reduce((sum, e) => sum + money(e.amount), 0n) !== 0n
    )
      throw Error(
        "Tally export contains missing or unbalanced ledger entries.",
      );
    const day = tallyDate(v.DATE);
    if (day < from || day > to)
      throw Error("Tally voucher date is outside the confirmed export period.");
    return {
      date: day,
      type: text(v.VOUCHERTYPENAME || v["@_VCHTYPE"]),
      masterId: text(v.MASTERID),
      guid: text(v.GUID || v["@_REMOTEID"]),
      remoteId: text(v["@_REMOTEID"]),
      number: text(v.VOUCHERNUMBER),
      narration: text(v.NARRATION),
      cancelled: text(v.ISCANCELLED).toLowerCase() === "yes",
      optional: text(v.ISOPTIONAL).toLowerCase() === "yes",
      entries,
    };
  });
  return {
    company: COMPANY,
    from,
    to,
    vouchers,
    sha256: await digest(xml),
    capturedAt: new Date().toISOString(),
    attestedComplete: input.complete === true,
  };
}
export function entryKey(entries) {
  return JSON.stringify(
    entries
      .map((e) => [e.ledger, decimal(money(e.amount))])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
  );
}
export function sameVoucher(job, voucher) {
  return (
    !voucher.cancelled &&
    !voucher.optional &&
    voucher.date === job.date &&
    voucher.type === job.type &&
    entryKey(voucher.entries) === entryKey(job.entries)
  );
}
export function matchingVouchers(job, evidence) {
  return evidence.vouchers.filter(
    (v) =>
      v.guid === job.remoteId ||
      v.remoteId === job.remoteId ||
      v.narration.includes(`[FIN:${job.id}]`),
  );
}
export function possibleExisting(job, evidence) {
  return evidence.vouchers.filter((v) => sameVoucher(job, v));
}
export async function bankVoucher(snapshot, rowIndex, input, masters) {
  const row = snapshot.rows[rowIndex];
  if (!row || !Number.isInteger(rowIndex))
    throw Error("Invalid statement row.");
  const bank = masters.ledgers.find((l) => l.name === input.bankLedger),
    counter = masters.ledgers.find((l) => l.name === input.counterLedger);
  if (!bank || !counter || bank.name === counter.name)
    throw Error("Choose two distinct existing Tally ledgers.");
  if (!["Bank Accounts", "Bank OD A/c"].includes(bank.parent))
    throw Error(
      "The bank ledger must belong directly to Bank Accounts or Bank OD A/c.",
    );
  if (
    counter.billwise &&
    (!input.billReference || input.billReference.length > 100)
  )
    throw Error("A bill reference is required for this bill-wise ledger.");
  const amount = money(row.debit) || money(row.credit),
    payment = money(row.debit) > 0n;
  const sourceKey = `bank:${row.fingerprint}`;
  const id = await digest(sourceKey),
    hash = await digest(`tally:${COMPANY}:${sourceKey}`);
  const remoteId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return {
    id,
    sourceKey,
    remoteId,
    company: COMPANY,
    date: row.date,
    type: payment ? "Payment" : "Receipt",
    description: row.description,
    reference: row.reference,
    source: {
      snapshotId: snapshot.sha256,
      rowIndex,
      fingerprint: row.fingerprint,
      accountLast4: snapshot.account.slice(-4),
    },
    catalogHash: masters.sha256,
    entries: [
      {
        ledger: counter.name,
        amount: decimal(payment ? -amount : amount),
        ...(counter.billwise
          ? { billReference: input.billReference, billType: "Agst Ref" }
          : {}),
      },
      { ledger: bank.name, amount: decimal(payment ? amount : -amount) },
    ],
  };
}
const esc = (value) => {
  const s = String(value);
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s))
    throw Error("Unsupported control character in voucher.");
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
};
export function voucherXml(jobs) {
  if (!jobs.length || jobs.length > 100)
    throw Error("Select 1–100 approved vouchers.");
  const body = jobs
    .map((j) => {
      if (
        j.company !== COMPANY ||
        !["Payment", "Receipt"].includes(j.type) ||
        j.entries.reduce((sum, e) => sum + money(e.amount), 0n) !== 0n
      )
        throw Error("Invalid or unbalanced posting batch.");
      const entries = j.entries
        .map(
          (e) =>
            `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${money(e.amount) < 0n ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${esc(e.amount)}</AMOUNT>${e.billReference ? `<BILLALLOCATIONS.LIST><NAME>${esc(e.billReference)}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>${esc(e.amount)}</AMOUNT></BILLALLOCATIONS.LIST>` : ""}</ALLLEDGERENTRIES.LIST>`,
        )
        .join("");
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(j.remoteId)}" VCHTYPE="${j.type}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${date(j.date).replaceAll("-", "")}</DATE><GUID>${esc(j.remoteId)}</GUID><VOUCHERTYPENAME>${j.type}</VOUCHERTYPENAME><VOUCHERNUMBER>FIN-${j.id.slice(0, 16)}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISOPTIONAL>No</ISOPTIONAL><NARRATION>${esc(`${j.description} ${j.reference} [FIN:${j.id}]`)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(COMPANY)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
