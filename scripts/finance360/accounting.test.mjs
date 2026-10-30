import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
const source = readFileSync("src/lib/finance360/model.ts", "utf8");
const mod = { exports: {} };
new Function(
  "exports",
  "module",
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText,
)(mod.exports, mod);
const { paise, decimal, parseJournals, parseBank, statements, date } =
  mod.exports;
const company = "10000000-0000-0000-0000-000000000001",
  other = "10000000-0000-0000-0000-000000000002",
  actor = "20000000-0000-0000-0000-000000000001";
const journal = (reference = "OPEN", d = "2026-04-01") => ({
  reference,
  date: d,
  narration: "Test fixture",
  lines: [
    {
      code: "BANK",
      name: "Test Bank",
      type: "asset",
      debit: "1000.00",
      credit: "0.00",
    },
    {
      code: "CAP",
      name: "Test Capital",
      type: "equity",
      debit: "0.00",
      credit: "1000.00",
    },
  ],
});
let db;
let hash = 0;
async function write(action, data, c = company) {
  return (
    await db.query(
      "select public.finance360_write($1,$2,$3,$4::jsonb) result",
      [
        c,
        actor,
        action,
        JSON.stringify({
          filename: "test only",
          sha256: String(++hash),
          ...data,
        }),
      ],
    )
  ).rows[0].result;
}
test("exact decimal validation and fiscal date validation", () => {
  assert.equal(paise("1,23,456.78"), 12345678n);
  assert.equal(decimal(-15n), "-0.15");
  for (const v of ["1.001", "NaN", "1e3", "-1"]) assert.throws(() => paise(v));
  assert.throws(() => date("2026-02-30"));
});
test("journal import rejects unbalanced and conflicting data", () => {
  const rows = [
    {
      date: "2026-10-06",
      reference: "1",
      narration: "Sale",
      account_code: "BANK",
      account_name: "Bank",
      account_type: "asset",
      debit: "100.10",
      credit: "",
    },
    {
      date: "2026-10-06",
      reference: "1",
      narration: "Sale",
      account_code: "REV",
      account_name: "Income",
      account_type: "income",
      debit: "",
      credit: "100.10",
    },
  ];
  assert.equal(parseJournals(rows).length, 1);
  assert.throws(
    () => parseJournals([{ ...rows[0], debit: "100.11" }, rows[1]]),
    /balance/,
  );
  assert.throws(
    () => parseJournals([rows[0], { ...rows[1], date: "2026-10-05" }]),
    /inconsistent/,
  );
});
test("bank imports validate direction, running balance and dates", () => {
  const rows = [
    {
      date: "2026-10-05",
      description: "Receipt",
      credit: "50",
      debit: "",
      balance: "150",
    },
    {
      date: "2026-10-06",
      description: "Expense",
      credit: "",
      debit: "20",
      balance: "130",
    },
  ];
  assert.equal(
    parseBank(rows, "100", "130", "2026-10-05", "2026-10-06").length,
    2,
  );
  assert.throws(
    () => parseBank(rows, "100", "131", "2026-10-05", "2026-10-06"),
    /closing balance/,
  );
  assert.throws(() =>
    parseBank([...rows].reverse(), "100", "130", "2026-10-05", "2026-10-06"),
  );
});
test("financial statements preserve prior-year retained result and period P&L", () => {
  const s = statements([
    {
      code: "A",
      name: "Bank",
      type: "asset",
      opening: "1000",
      debit: "300",
      credit: "100",
      closing: "1200",
    },
    {
      code: "E",
      name: "Capital",
      type: "equity",
      opening: "-900",
      debit: "0",
      credit: "0",
      closing: "-900",
    },
    {
      code: "I",
      name: "Revenue",
      type: "income",
      opening: "-100",
      debit: "0",
      credit: "300",
      closing: "-400",
    },
    {
      code: "X",
      name: "Expense",
      type: "expense",
      opening: "0",
      debit: "100",
      credit: "0",
      closing: "100",
    },
  ]);
  assert.equal(s.profit, 20000n);
  assert.equal(s.accumulatedProfit, 30000n);
  assert.equal(s.balanceDifference, 0n);
  assert.equal(s.difference, 0n);
});
test("database accounting controls and reports", async (t) => {
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role;create table public.companies(id uuid primary key);insert into companies values('${company}'),('${other}');create table public.app_pages(company_id uuid,code text,name text,sort_order int,is_active bool,unique(company_id,code));create table public.company_product_memberships(company_id uuid,product_code text);insert into company_product_memberships values('${company}','finance');`,
  );
  await db.exec(readFileSync("scripts/finance360/schema.sql", "utf8"));
  await t.test("atomic balanced journal posting", async () => {
    await write("journal", { vouchers: [journal()] });
    const r = await db.query("select * from finance360_trial($1,$2,$3)", [
      company,
      "2026-04-01",
      "2026-10-06",
    ]);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows.find((r) => r.code === "BANK").closing, "1000.00");
  });
  await t.test(
    "duplicate source and duplicate reference rejected",
    async () => {
      await assert.rejects(
        write("journal", { vouchers: [journal()] }),
        /unique/,
      );
    },
  );
  await t.test("unbalanced batch rolls back everything", async () => {
    const v = journal("BAD");
    v.lines[1].credit = "999.99";
    await assert.rejects(
      write("journal", { vouchers: [journal("VALID-BUT-ROLLBACK"), v] }),
      /balanced/,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from finance360_journals where reference='VALID-BUT-ROLLBACK'",
        )
      ).rows[0].n,
      0,
    );
  });
  await t.test("cannot append lines or modify posted history", async () => {
    const j = (await db.query("select id from finance360_journals limit 1"))
      .rows[0].id;
    await assert.rejects(
      db.query("update finance360_journals set narration=$1 where id=$2", [
        "Changed",
        j,
      ]),
      /immutable/,
    );
    await assert.rejects(
      db.query(
        "insert into finance360_lines(company_id,journal_id,account_code,debit,credit) values($1,$2,$3,1,0)",
        [company, j, "BANK"],
      ),
      /append/,
    );
  });
  await t.test(
    "company scope is enforced by composite keys and reports",
    async () => {
      assert.deepEqual(
        (
          await db.query("select * from finance360_trial($1,$2,$3)", [
            other,
            "2026-04-01",
            "2026-10-06",
          ])
        ).rows,
        [],
      );
      await assert.rejects(
        write(
          "loan",
          {
            facility: "F",
            lender: "L",
            account_code: "CAP",
            as_of: "2026-10-06",
            principal: "1",
            interest_due: "0",
            emi: "0",
            note: "test",
          },
          other,
        ),
        /liability/,
      );
    },
  );
  await t.test(
    "statement upload, overlap rejection and exact ledger matching",
    async () => {
      await write("bank", {
        account_code: "BANK",
        start: "2026-04-01",
        end: "2026-04-01",
        opening: "0",
        closing: "1000",
        rows: [
          {
            date: "2026-04-01",
            description: "Capital",
            reference: "CAP",
            debit: "0",
            credit: "1000",
            balance: "1000",
          },
        ],
      });
      await assert.rejects(
        write("bank", {
          account_code: "BANK",
          start: "2026-04-01",
          end: "2026-04-02",
          opening: "0",
          closing: "1000",
          rows: [],
        }),
        /overlaps/,
      );
      const row = (await db.query("select id from finance360_bank_rows"))
        .rows[0].id;
      const bank = (
        await db.query(
          "select id from finance360_lines where account_code='BANK'",
        )
      ).rows[0].id;
      const wrong = (
        await db.query(
          "select id from finance360_lines where account_code='CAP'",
        )
      ).rows[0].id;
      await assert.rejects(
        write("match", { row_id: row, line_id: wrong }),
        /same bank/,
      );
      await write("match", { row_id: row, line_id: bank });
      await assert.rejects(
        write("match", { row_id: row, line_id: bank }),
        /already reconciled/,
      );
      await write("unmatch", { row_id: row, reason: "Test correction" });
      assert.equal(
        (await db.query("select matched_line_id from finance360_bank_rows"))
          .rows[0].matched_line_id,
        null,
      );
    },
  );
  await t.test("bad bank running balance rolls back", async () => {
    await assert.rejects(
      write("bank", {
        account_code: "BANK",
        start: "2026-04-02",
        end: "2026-04-02",
        opening: "1000",
        closing: "1010",
        rows: [
          {
            date: "2026-04-02",
            description: "Test",
            reference: "T",
            debit: "0",
            credit: "10",
            balance: "999",
          },
        ],
      }),
      /balance mismatch/,
    );
  });
  await t.test(
    "adjacent bank statements must join and coverage resets after backdated posting",
    async () => {
      await assert.rejects(
        write("bank", {
          account_code: "BANK",
          start: "2026-04-02",
          end: "2026-04-02",
          opening: "999",
          closing: "1009",
          rows: [],
        }),
        /adjacent/,
      );
      await write("coverage", {
        start: "2026-04-01",
        end: "2026-10-06",
        reason: "Fixture attestation",
      });
      await write("journal", { vouchers: [journal("BACKDATE", "2026-04-02")] });
      assert.equal(
        (
          await db.query(
            "select coverage_through from finance360_books where company_id=$1",
            [company],
          )
        ).rows[0].coverage_through,
        null,
      );
    },
  );
  await t.test("reversal preserves originals and balances", async () => {
    const j = (
      await db.query(
        "select id from finance360_journals where reference='OPEN'",
      )
    ).rows[0].id;
    await write("reversal", {
      journal_id: j,
      date: "2026-04-03",
      reference: "REV-OPEN",
      narration: "Reversal fixture",
    });
    const r = await db.query("select * from finance360_trial($1,$2,$3)", [
      company,
      "2026-04-01",
      "2026-10-06",
    ]);
    assert.equal(r.rows.find((r) => r.code === "BANK").closing, "1000.00");
    await assert.rejects(
      write("reversal", {
        journal_id: j,
        date: "2026-04-03",
        reference: "REV-DUP",
        narration: "Duplicate",
      }),
      /unique/,
    );
  });
  await t.test(
    "period locks prevent backdating and cannot move backward",
    async () => {
      await write("lock", { date: "2026-04-30", reason: "Test close" });
      await assert.rejects(
        write("journal", { vouchers: [journal("LOCKED")] }),
        /locked/,
      );
      await assert.rejects(
        write("lock", { date: "2026-04-01", reason: "Back" }),
        /reopened/,
      );
      await write("journal", { vouchers: [journal("MAY", "2026-05-01")] });
    },
  );
  await t.test(
    "loans use latest snapshot by facility and report cutoff",
    async () => {
      await write("account", { code: "LOAN", name: "Loan", type: "liability" });
      await write("loan", {
        facility: "F",
        lender: "L",
        account_code: "LOAN",
        as_of: "2026-10-05",
        principal: "1000",
        interest_due: "10",
        emi: "100",
        next_due: "2026-11-01",
        note: "Test",
      });
      await write("loan", {
        facility: "F",
        lender: "L",
        account_code: "LOAN",
        as_of: "2026-10-07",
        principal: "900",
        interest_due: "5",
        emi: "100",
        note: "Test",
      });
      const s = (
        await db.query("select finance360_summary($1,$2) s", [
          company,
          "2026-10-06",
        ])
      ).rows[0].s;
      assert.equal(s.loans[0].principal, "1000.00");
      assert.equal(s.loans.length, 1);
      assert.ok(s.imports > 0);
    },
  );
  await t.test(
    "anonymous and browser-authenticated database access is denied",
    async () => {
      await db.exec("set role authenticated");
      await assert.rejects(
        db.query("select * from finance360_lines"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select finance360_summary($1,$2)", [company, "2026-10-06"]),
        /permission denied/,
      );
      await db.exec("reset role");
    },
  );
  await db.close();
});
