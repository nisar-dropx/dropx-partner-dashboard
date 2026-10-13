import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(
  new URL("../../../../../supabase/migrations/20261013120000_legacy_payout_bank_response_reference_resolution.sql", import.meta.url),
  "utf8"
);

const companyId = "00000000-0000-4000-8000-000000000001";

test("legacy bare-ID resolver is deterministic across processing and paid ledger evidence", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create function public.payout_bank_reference_dropx_canonical(p_value text)
      returns text language sql immutable as $$
        select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g')
      $$;
      create function public.workforce_payout_bank_account_canonical(p_value text)
      returns text language sql immutable as $$
        select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[[:space:]‌-‏﻿]', '', 'g')
      $$;
      create function public.workforce_payout_bank_ifsc_canonical(p_value text)
      returns text language sql immutable as $$
        select public.workforce_payout_bank_account_canonical(p_value)
      $$;
      create table public.workforce_payout_payment_items (
        id uuid primary key,
        company_id uuid not null,
        reference_no text not null,
        dropx_id_snapshot text not null,
        bank_account_no_snapshot text not null,
        ifsc_snapshot text not null,
        instruction_amount numeric(14,2) not null,
        status text not null,
        utr_cin text
      );
      create table public.helper_payout_payment_items (
        id uuid primary key,
        company_id uuid not null,
        reference_no text not null,
        dropx_id_snapshot text not null,
        bank_account_no_snapshot text not null,
        ifsc_snapshot text not null,
        instruction_amount numeric(14,2) not null,
        status text not null,
        utr_cin text
      );
    `);
    await db.exec(migration);
    await db.query(`
      insert into public.workforce_payout_payment_items values
        ('10000000-0000-4000-8000-000000000001', $1, 'WFDF1141102026V1', 'df-1141', 'ACC-WF', 'IFSC-WF', 100.00, 'processing', null),
        ('10000000-0000-4000-8000-000000000002', $1, 'WFDF1141092026V1', 'DF1141', 'OLD-ACC', 'OLD-IFSC', 100.00, 'paid', 'REPLAY-UTR'),
        ('10000000-0000-4000-8000-000000000003', $1, 'WFT1013092026V1', 'T1013', 'ACC-ONE', 'IFSC-ONE', 500.00, 'processing', null),
        ('10000000-0000-4000-8000-000000000004', $1, 'WFT1013092026V2', 'T1013', 'ACC-TWO', 'IFSC-TWO', 500.00, 'processing', null)
    `, [companyId]);
    await db.query(`
      insert into public.helper_payout_payment_items values
        ('20000000-0000-4000-8000-000000000001', $1, 'HPD0826102026V1', 'D0826', 'ACC-HP', 'IFSC-HP', 50.00, 'processing', null)
    `, [companyId]);

    const inputs = [
      { row_number: 2, dropx_id: "DF 1141", debit_amount_paise: 10000, credit_account: "MISMATCH", ifsc: "MISMATCH", status: "PAID", utr_cin: "NEW-UTR" },
      { row_number: 3, dropx_id: "D0826", debit_amount_paise: 5000, credit_account: "", ifsc: "", status: "PAID", utr_cin: "HELPER-UTR" },
      { row_number: 4, dropx_id: "T1013", debit_amount_paise: 50000, credit_account: "ACC-TWO", ifsc: "", status: "PAID", utr_cin: "T-UTR" },
      { row_number: 5, dropx_id: "T1013", debit_amount_paise: 50000, credit_account: "", ifsc: "", status: "PAID", utr_cin: "T-UTR-2" },
      { row_number: 6, dropx_id: "BANKOTHER001", debit_amount_paise: 2500, credit_account: "", ifsc: "", status: "PAID", utr_cin: "OTHER" },
      { row_number: 7, dropx_id: "DF1141", debit_amount_paise: 99900, credit_account: "", ifsc: "", status: "PAID", utr_cin: "NO-AMOUNT" },
      { row_number: 8, dropx_id: "DF1141", debit_amount_paise: 10000, credit_account: "", ifsc: "", status: "PAID", utr_cin: " replay utr " }
    ];
    const result = await db.query(
      "select * from public.resolve_owned_payout_legacy_response_references($1, $2::jsonb) order by row_number",
      [companyId, JSON.stringify(inputs)]
    );

    assert.deepEqual(result.rows.map((row) => ({
      audience: row.audience,
      reference: row.reference_no,
      row: row.row_number,
      state: row.resolution_state
    })), [
      { audience: "workforce", reference: "WFDF1141102026V1", row: 2, state: "resolved" },
      { audience: "helpers", reference: "HPD0826102026V1", row: 3, state: "resolved" },
      { audience: "workforce", reference: "WFT1013092026V2", row: 4, state: "resolved" },
      { audience: null, reference: null, row: 5, state: "error" },
      { audience: null, reference: null, row: 6, state: "unrelated" },
      { audience: null, reference: null, row: 7, state: "error" },
      { audience: "workforce", reference: "WFDF1141092026V1", row: 8, state: "resolved" }
    ]);
    assert.match(result.rows[3].message, /match 2 Payment Processing instructions/i);
    assert.match(result.rows[5].message, /no Payment Processing instruction has the exact bank amount/i);
  } finally {
    await db.close();
  }
});
