import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  analyseCycleCount,
  analyseDgFuel,
  analyseExpiryRemoved,
  analyseStowingPendency,
  analyseWithImageScraper,
  istWallClockMs,
  looksLikeAutomationFlash,
  matchScrapable,
  parseExpiryDates,
  parseStowingQuantity,
  quantityNearLabel
} from "./image-scraper.ts";

/** Fixed “now” in Asia/Kolkata for expiry timestamp comparisons. */
const asOf = (date, hours = 12, minutes = 0) => istWallClockMs(date, hours, minutes, 0);

const cycle = {
  id: "cycle-1",
  name: "Cycle count, SBC & SRC completion",
  slug: "cycle-count-sbc-src",
  rules: [
    "Read the Cycle Count, SBC and SRC task quantities from the device screenshot.",
    "Pass only when all three quantities are exactly 0.",
    "Any positive, missing, cropped or unreadable quantity remains pending; never assume it is zero."
  ],
  feedback_hint: "Please complete the remaining Cycle Count, SBC and SRC tasks and share a fresh device screenshot."
};

const expiry = {
  id: "expiry-1",
  name: "Expiry removed",
  slug: "expiry-removed",
  rules: [
    "Check the Expiration column against today in Asia/Kolkata.",
    "Check the quantity for every current or past-date row.",
    "Pass only when there are no current or past-date rows with quantity above 0."
  ]
};

const stowing = {
  id: "stow-1",
  name: "Stowing pendency",
  slug: "stowing-pendency",
  rules: [
    "Extract stowing pendency quantity from a reply or new message.",
    "Pass only when the quantity is exactly 0; a positive quantity remains pending."
  ]
};

const dg = {
  id: "dg-1",
  name: "DG fuel level",
  slug: "dg-fuel-level",
  rules: ["A DG fuel level image is attached."],
  auto_reply_policy: "never"
};

describe("cycle count scraper", () => {
  test("reads BOH Guided, SBC and Ad Hoc and fails when not zero", () => {
    const ocr = `
      Unified Cycle Count
      BOH Guided 96
      Simple Bin Count 298
      Ad Hoc 12
      User chmuthul
      Device ID DU-AA-45
    `;
    const result = analyseCycleCount(cycle, ocr);
    assert.equal(result.verdict, "fail");
    assert.equal(result.extracted_fields.find((f) => f.label === "BOH Guided")?.value, "96");
    assert.equal(result.extracted_fields.find((f) => f.label === "Simple Bin Count")?.value, "298");
    assert.equal(result.extracted_fields.find((f) => f.label === "Ad Hoc / SRC")?.value, "12");
  });

  test("passes only when all three quantities are zero", () => {
    const ocr = "Unified Cycle Count\nBOH Guided 0\nSimple Bin Count 0\nAd Hoc 0";
    const result = analyseCycleCount(cycle, ocr);
    assert.equal(result.verdict, "pass");
  });

  test("does not assume missing Ad Hoc is zero", () => {
    const ocr = "Unified Cycle Count\nBOH Guided 0\nSimple Bin Count 0";
    const result = analyseCycleCount(cycle, ocr);
    assert.equal(result.verdict, "needs_review");
  });

  test("rejects wrong menu (Expiry Awareness)", () => {
    const ocr = "Expiry Awareness\nAudit FOH\nAudit BOH\nBin Check";
    const result = analyseCycleCount(cycle, ocr);
    assert.equal(result.verdict, "needs_review");
    assert.match(result.extracted_summary, /not a Cycle Count/i);
  });
});

describe("expiry scraper", () => {
  test("parses mixed date formats", () => {
    assert.deepEqual(parseExpiryDates("Expiration 2026-11-21 23:59 and 11/22/2026"), [
      "2026-11-21",
      "2026-11-22"
    ]);
  });

  test("passes when all visible date+times are still in the future", () => {
    const ocr = "Expiry Dashboard\nExpiration 2026-11-21\nQuantity 12\nExpiration 11/22/2026 4";
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-20", asOf("2026-11-20", 12));
    assert.equal(result.verdict, "pass");
  });

  test("fails when a past date+time still has quantity", () => {
    const ocr = "Expiry Dashboard Expiration 2026-11-19 Quantity 5 ASIN B00";
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-20", asOf("2026-11-20", 12));
    assert.equal(result.verdict, "fail");
  });

  test("reads Excel snapshot with today 23:59 shrink as received before that time", () => {
    const ocr = `
      DU-AA-35_EXPIRATION_AUDIT_SNAPSHOT
      Bin Name Product Expiration Shrink Quantity Unit ASIN
      CHL-A01B HERITAGE GOLD MILK 11/24/2026 23:59 11/24/2026 23:59 8 unit B0H7JNK6
      AMB-G01J Fresh Onion 11/25/2026 23:59 11/24/2026 23:59 12 unit B08B4367
    `;
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-24", asOf("2026-11-24", 11, 18));
    assert.equal(result.verdict, "pass");
    assert.match(result.extracted_summary, /2026-11-24|received|future/i);
  });

  test("fails Excel today 23:59 after that timestamp has passed", () => {
    const ocr = `
      DU-AA-35_EXPIRATION_AUDIT_SNAPSHOT
      Bin Name Product Expiration Shrink Quantity Unit ASIN
      CHL-A01B HERITAGE GOLD MILK 11/24/2026 23:59 11/24/2026 23:59 8 unit B0H7JNK6
    `;
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-24", asOf("2026-11-25", 0, 1));
    assert.equal(result.verdict, "fail");
  });

  test("reads Ihm web dashboard and passes when only later-today / future shrink remains", () => {
    const ocr = `
      Ihm Inventory Expiration Audit Dashboard TEZ-HYDERABAD-TTG9
      Bin Name Product Name Expiration Shrink Quantity Unit ASIN
      CHL-A08E4 Sid's Farm High Protein Milk 2026-11-25 23:59 2026-11-24 23:59 15 unit B0FGDFKV7C
      CHL-B02B2 Fresh Chinese Cabbage 2026-11-25 23:59 2026-11-24 23:59 1 unit B0ABC
    `;
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-24", asOf("2026-11-24", 7, 6));
    assert.equal(result.verdict, "pass");
  });

  test("still fails when a past shrink date+time has quantity", () => {
    const ocr = `
      DU-AA-45_EXPIRATION_AUDIT_SNAPSHOT
      Bin Name Product Expiration Shrink Quantity Unit ASIN
      CHL-B HERITAGE 11/23/2026 23:59 11/23/2026 23:59 8 unit B0H7
      AMB-I Fresh Onion 11/25/2026 23:59 11/24/2026 23:59 12 unit B08B
    `;
    const result = analyseExpiryRemoved(expiry, ocr, "2026-11-24", asOf("2026-11-24", 12));
    assert.equal(result.verdict, "fail");
  });

  test("accepts pasted Expired Items text with Total Expired Items 0 as pass", () => {
    const text = `
      Expired Items at TTB3
      ASIN Shrink Date Qty LocationId
      Total Expired Items: 0
    `;
    const result = analyseExpiryRemoved(expiry, text, "2026-11-24", asOf("2026-11-24", 12));
    assert.equal(result.verdict, "pass");
  });

  test("pasted expired table with positive total fails without an image", () => {
    const text = `
      Expired Items at TTB3
      ASIN            Shrink Date          Qty        LocationId
      B09VSKJ1G4      2026-11-20 18:29:59  2.0        Bin:AMB-Q05C2
      Total Expired Items: 1
    `;
    const result = analyseWithImageScraper({
      candidates: [expiry],
      businessDate: "2026-11-24",
      text,
      hasImage: false,
      ocrText: "",
      asOfMs: asOf("2026-11-24", 12)
    });
    assert.equal(result?.verdict, "fail");
    assert.equal(result?.matched_report_type_id, expiry.id);
  });
});

describe("stowing scraper", () => {
  test("reads quantity from common phrasings", () => {
    assert.equal(parseStowingQuantity("Stowing pendency: 0"), 0);
    assert.equal(parseStowingQuantity("pendency 14"), 14);
    assert.equal(parseStowingQuantity("0"), 0);
  });

  test("passes at zero and fails when positive", () => {
    assert.equal(analyseStowingPendency(stowing, "stowing pendency 0").verdict, "pass");
    assert.equal(analyseStowingPendency(stowing, "stowing pendency 9").verdict, "fail");
  });
});

describe("dg fuel scraper", () => {
  test("passes when an image is attached", () => {
    const result = analyseDgFuel(dg, { hasImage: true, ocrText: "DG Fuel 62%", messageText: "fuel level" });
    assert.equal(result.verdict, "pass");
  });

  test("fails without an image", () => {
    const result = analyseDgFuel(dg, { hasImage: false, ocrText: "", messageText: "DG fuel" });
    assert.equal(result.verdict, "fail");
  });
});

describe("match + orchestrate", () => {
  test("matches cycle count from OCR signatures among open requests", () => {
    const matched = matchScrapable({
      candidates: [cycle, expiry, stowing, dg],
      businessDate: "2026-11-20",
      hasImage: true,
      ocrText: "Unified Cycle Count BOH Guided 1 Simple Bin Count 2 Ad Hoc 0"
    });
    assert.equal(matched?.slug, "cycle-count-sbc-src");
  });

  test("matches bare number reply to stowing when that request is open", () => {
    const result = analyseWithImageScraper({
      candidates: [stowing],
      businessDate: "2026-11-20",
      text: "0",
      hasImage: false
    });
    assert.equal(result?.verdict, "pass");
    assert.equal(result?.matched_report_type_id, "stow-1");
  });

  test("quantityNearLabel tolerates OCR gaps and O/0 confusion", () => {
    assert.equal(quantityNearLabel("BOH Guided\n96 tasks", [/boh\s*guided/i]), 96);
    assert.equal(quantityNearLabel("Simple Bin Count O", [/\bsbc\b/i, /simple\s*bin\s*count/i]), 0);
  });

  test("bulk mix: prefers waiting expiry over already-received cycle when OCR says expiry", () => {
    const matched = matchScrapable({
      candidates: [
        { ...cycle, requestStatus: "received" },
        { ...expiry, requestStatus: "pending" },
        { ...stowing, requestStatus: "pending" },
        { ...dg, requestStatus: "pending" }
      ],
      businessDate: "2026-11-20",
      hasImage: true,
      ocrText: "Expiry Dashboard Expiration 2026-11-25 Quantity 0"
    });
    assert.equal(matched?.slug, "expiry-removed");
  });

  test("bulk mix: image without stowing words does not steal a bare-number stowing slot", () => {
    const matched = matchScrapable({
      candidates: [
        { ...cycle, requestStatus: "pending" },
        { ...stowing, requestStatus: "pending" }
      ],
      businessDate: "2026-11-20",
      hasImage: true,
      caption: "done",
      ocrText: "Unified Cycle Count BOH Guided 0 Simple Bin Count 0 Ad Hoc 0"
    });
    assert.equal(matched?.slug, "cycle-count-sbc-src");
  });

  test("dg fuel passes with image even when OCR is weak", () => {
    const result = analyseWithImageScraper({
      candidates: [{ ...dg, requestStatus: "pending" }],
      businessDate: "2026-11-20",
      hasImage: true,
      ocrText: ""
    });
    assert.equal(result?.verdict, "pass");
  });

  test("PPI / Site Summary captions are never matched as completion reports", () => {
    assert.equal(looksLikeAutomationFlash("TCD4\n• PPI today as of 10:00 hrs: 62.25s"), true);
    assert.equal(looksLikeAutomationFlash("ssmon_TCD4 active orders"), true);
    const matched = matchScrapable({
      candidates: [{ ...cycle, requestStatus: "pending" }, { ...expiry, requestStatus: "pending" }],
      businessDate: "2026-11-26",
      hasImage: true,
      caption: "*TCD4*\n• PPI today as of 10:00 hrs: 62.25s",
      ocrText: "DropX Dark Store | Total Performance"
    });
    assert.equal(matched, null);
  });

  test("image without OCR does not steal a waiting cycle-count slot", () => {
    const matched = matchScrapable({
      candidates: [{ ...cycle, requestStatus: "pending" }, { ...expiry, requestStatus: "received" }],
      businessDate: "2026-11-26",
      hasImage: true,
      caption: "photo",
      ocrText: ""
    });
    assert.equal(matched, null);
  });
});
