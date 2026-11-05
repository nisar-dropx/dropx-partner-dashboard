import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkforcePayoutExportTable } from "./workforce-payout-export.ts";

const combinedMethodRow = {
  dropxId: "N1013",
  dropxStatus: "Active",
  name: "ELDHOSE THOMAS",
  designation: "DR - Driver",
  providerMemberId: "2000078396420",
  providerMemberName: "ELDHOSE THOMAS / DROP / 207254383",
  location: "KTUO",
  provider: "Amazon",
  model: "EDSP - EDSP",
  paymentMethod: "Per Packet & Van Rent Per Day",
  mappingStatus: "Mapped",
  paymentDetailsAvailable: true,
  workDays: 28,
  workDaysSource: "Biometric",
  productionBreakdown: [
    { code: "DELIVERY", label: "Delivery", componentType: "production", count: 843, rate: 13, amount: 10959 },
    { code: "CRETURN", label: "C-return", componentType: "production", count: 133, rate: 16, amount: 2128 },
    { code: "MG_PER_MONTH", label: "MG Per Month", componentType: "amount", count: 0.93, rate: 18000, amount: 16800 },
    { code: "VAN_RENT_PER_DAY", label: "Van Rent Per Day", componentType: "amount", count: 28, rate: 800, amount: 22400 }
  ],
  baseAmount: 52287,
  additions: 0,
  grossPayment: 52287,
  deductions: 523,
  deductionBreakdown: [{ code: "TDS", label: "TDS Deduction", amount: 523 }],
  netAmount: 51764,
  paymentSummary: { paidAmount: 12000, processingAmount: 5000 },
  panAadhaarStatus: "NOT LINKED",
  status: "Ready for review"
};

test("payout export keeps production detail and removes duplicate payment-method totals", () => {
  const table = buildWorkforcePayoutExportTable([combinedMethodRow], "Workforce");

  assert.equal(table.headers.length, new Set(table.headers).size, "every export header must be unique");
  assert.doesNotMatch(table.headers.join("|"), /Per Packet & Van Rent Per Day Amount/);
  assert.doesNotMatch(table.headers.join("|"), /Per Packet Amount/);
  assert.deepEqual(
    table.headers.filter((header) => header.startsWith("Delivery ")),
    ["Delivery Units", "Delivery Rate (INR)", "Delivery Amount (INR)"]
  );
  assert.deepEqual(
    table.headers.filter((header) => header.startsWith("C-return ")),
    ["C-return Units", "C-return Rate (INR)", "C-return Amount (INR)"]
  );
});

test("attendance and rent heads export units before rate and amount", () => {
  const table = buildWorkforcePayoutExportTable([combinedMethodRow], "Workforce");
  const headers = table.headers.join("|");

  assert.doesNotMatch(headers, /MG Per Month Count/);
  assert.doesNotMatch(headers, /Van Rent Per Day Count/);
  assert.match(headers, /MG Per Month Units\|MG Per Month Rate \(INR\)\|MG Per Month Amount \(INR\)/);
  assert.match(headers, /Van Rent Per Day Units\|Van Rent Per Day Rate \(INR\)\|Van Rent Per Day Amount \(INR\)/);
  assert.equal(table.rows[0][table.headers.indexOf("Van Rent Per Day Rate (INR)")], 800);
  assert.equal(table.rows[0][table.headers.indexOf("Van Rent Per Day Amount (INR)")], 22400);
});

test("additional payment fields export as named human-readable columns", () => {
  const row = {
    ...combinedMethodRow,
    additionalPaymentBreakdown: [
      { fieldId: "bonus", code: "BONUS", label: "Festival Bonus", calculationType: "manual_amount", inputValue: 750, rateValue: null, amount: 750 },
      { fieldId: "km", code: "KM_INCENTIVE", label: "KM Incentive", calculationType: "units_x_rate", inputValue: 40, rateValue: 3, amount: 120 }
    ],
    additions: 870,
    grossPayment: 53157,
    netAmount: 52634
  };
  const table = buildWorkforcePayoutExportTable([row], "Workforce");

  assert.equal(table.rows[0][table.headers.indexOf("Festival Bonus (INR)")], 750);
  assert.equal(table.rows[0][table.headers.indexOf("KM Incentive Units")], 40);
  assert.equal(table.rows[0][table.headers.indexOf("KM Incentive Rate (INR)")], 3);
  assert.equal(table.rows[0][table.headers.indexOf("Additional Payments (INR)")], 870);
});

test("payout export preserves the payment method's custom mixed field order", () => {
  const customOrder = {
    ...combinedMethodRow,
    productionBreakdown: [
      { code: "VAN_RENT_PER_DAY", label: "Van Rent Per Day", componentType: "amount", count: 28, rate: 800, amount: 22400 },
      { code: "CRETURN", label: "C-return", componentType: "production", count: 133, rate: 16, amount: 2128 },
      { code: "MG_PER_MONTH", label: "MG Per Month", componentType: "amount", count: 0.93, rate: 18000, amount: 16800 },
      { code: "DELIVERY", label: "Delivery", componentType: "production", count: 843, rate: 13, amount: 10959 }
    ]
  };
  const table = buildWorkforcePayoutExportTable([customOrder], "Workforce");

  assert.deepEqual(
    table.headers.filter((header) => /^(Van Rent Per Day|C-return|MG Per Month|Delivery) /.test(header)),
    [
      "Van Rent Per Day Units",
      "Van Rent Per Day Rate (INR)",
      "Van Rent Per Day Amount (INR)",
      "C-return Units",
      "C-return Rate (INR)",
      "C-return Amount (INR)",
      "MG Per Month Units",
      "MG Per Month Rate (INR)",
      "MG Per Month Amount (INR)",
      "Delivery Units",
      "Delivery Rate (INR)",
      "Delivery Amount (INR)"
    ]
  );
});

test("payout export uses human labels, exact partner IDs, and one deduction suffix", () => {
  const table = buildWorkforcePayoutExportTable([combinedMethodRow], "Workforce");

  assert.deepEqual(table.headers.slice(0, 11), ["DropX ID", "DropX Status", "Workforce Name", "Designation", "Partner Name", "Partner ID", "Location", "Provider", "Model", "Payment Method", "Work Days"]);
  assert.equal(table.rows[0][table.headers.indexOf("Designation")], "DR");
  assert.ok(!table.headers.includes("Base Payment (INR)"));
  assert.ok(!table.headers.includes("Attendance Source"));
  assert.equal(table.rows[0][table.headers.indexOf("Partner ID")], '="2000078396420"');
  assert.ok(table.headers.includes("TDS Deduction (INR)"));
  assert.equal(table.headers.some((header) => /Deduction Deduction/.test(header)), false);
  assert.equal(table.rows[0][table.headers.indexOf("Gross Payment (INR)")], 52287);
  assert.equal(table.rows[0][table.headers.indexOf("Net Pay (INR)")], 51764);
  assert.deepEqual(
    table.headers.slice(
      table.headers.indexOf("Net Pay (INR)"),
      table.headers.indexOf("PAN-Aadhaar Status") + 1
    ),
    ["Net Pay (INR)", "Paid (INR)", "Processing (INR)", "Balance Payable (INR)", "PAN-Aadhaar Status"]
  );
  assert.equal(table.rows[0][table.headers.indexOf("Paid (INR)")], 12000);
  assert.equal(table.rows[0][table.headers.indexOf("Processing (INR)")], 5000);
  assert.equal(table.rows[0][table.headers.indexOf("Balance Payable (INR)")], 34764);
});

test("unmapped provider report rows export blank DropX and payment details", () => {
  const unmapped = {
    ...combinedMethodRow,
    dropxId: "",
    dropxStatus: "",
    name: "UNMAPPED PARTNER PERSON",
    designation: "",
    mappingStatus: "ID not mapped",
    paymentDetailsAvailable: false,
    paymentMethod: "",
    productionBreakdown: [],
    deductionBreakdown: [],
    status: "ID not mapped"
  };
  const table = buildWorkforcePayoutExportTable([combinedMethodRow, unmapped], "Workforce");
  const row = table.rows[1];

  assert.equal(row[table.headers.indexOf("DropX ID")], "");
  assert.equal(row[table.headers.indexOf("Designation")], "");
  assert.equal(row[table.headers.indexOf("Payment Method")], "");
  assert.equal(row[table.headers.indexOf("Gross Payment (INR)")], "");
  assert.equal(row[table.headers.indexOf("Net Pay (INR)")], "");
  assert.equal(row[table.headers.indexOf("Paid (INR)")], "");
  assert.equal(row[table.headers.indexOf("Processing (INR)")], "");
  assert.equal(row[table.headers.indexOf("Balance Payable (INR)")], "");
  assert.equal(row[table.headers.indexOf("Mapping Status")], "ID not mapped");
});

test("payment balance export uses Net Pay minus Paid minus Processing at paise precision", () => {
  const table = buildWorkforcePayoutExportTable([{
    ...combinedMethodRow,
    netAmount: 1000.10,
    paymentSummary: {
      paidAmount: 100.05,
      processingAmount: 200.02,
      balancePayable: 700
    }
  }], "Workforce");
  const row = table.rows[0];

  assert.equal(row[table.headers.indexOf("Paid (INR)")], 100.05);
  assert.equal(row[table.headers.indexOf("Processing (INR)")], 200.02);
  assert.equal(row[table.headers.indexOf("Balance Payable (INR)")], 700.03);
});

test("payment lifecycle export stays blank when a mapped row has no ledger summary", () => {
  const { paymentSummary: _paymentSummary, ...rowWithoutSummary } = combinedMethodRow;
  const table = buildWorkforcePayoutExportTable([rowWithoutSummary], "Workforce");
  const row = table.rows[0];

  assert.equal(row[table.headers.indexOf("Paid (INR)")], "");
  assert.equal(row[table.headers.indexOf("Processing (INR)")], "");
  assert.equal(row[table.headers.indexOf("Balance Payable (INR)")], "");
});

test("payment lifecycle export stays blank when the payment balance is unavailable", () => {
  const table = buildWorkforcePayoutExportTable([{
    ...combinedMethodRow,
    paymentSummary: {
      paidAmount: 0,
      processingAmount: 0,
      eligible: false,
      eligibilityCode: "publication_missing"
    }
  }], "Workforce");
  const row = table.rows[0];

  assert.equal(row[table.headers.indexOf("Paid (INR)")], "");
  assert.equal(row[table.headers.indexOf("Processing (INR)")], "");
  assert.equal(row[table.headers.indexOf("Balance Payable (INR)")], "");
});

test("Helper export keeps authoritative balances when bank eligibility is blocked", () => {
  const table = buildWorkforcePayoutExportTable([{
    ...combinedMethodRow,
    netAmount: 1500,
    paymentSummary: {
      paidAmount: 500,
      processingAmount: 200,
      eligible: false,
      eligibilityCode: "bank_details_missing"
    }
  }], "Helper");
  const row = table.rows[0];

  assert.equal(row[table.headers.indexOf("Paid (INR)")], 500);
  assert.equal(row[table.headers.indexOf("Processing (INR)")], 200);
  assert.equal(row[table.headers.indexOf("Balance Payable (INR)")], 800);
});

test("payment balance cannot become negative when paid and processing exceed Net Pay", () => {
  const table = buildWorkforcePayoutExportTable([{
    ...combinedMethodRow,
    netAmount: 1000,
    paymentSummary: { paidAmount: 800, processingAmount: 300 }
  }], "Workforce");

  assert.equal(table.rows[0][table.headers.indexOf("Balance Payable (INR)")], 0);
});

test("separately configured heads with the same display name remain identifiable", () => {
  const row = {
    ...combinedMethodRow,
    productionBreakdown: [
      { code: "ALLOWANCE_A", label: "Allowance", componentType: "amount", count: 0, rate: 100, amount: 100 },
      { code: "ALLOWANCE_B", label: "Allowance", componentType: "amount", count: 0, rate: 200, amount: 200 }
    ],
    deductionBreakdown: [
      { code: "RECOVERY_A", label: "Recovery", amount: 10 },
      { code: "RECOVERY_B", label: "Recovery", amount: 20 }
    ]
  };
  const table = buildWorkforcePayoutExportTable([row], "Workforce");

  assert.equal(table.headers.length, new Set(table.headers).size, "configured label collisions must not duplicate CSV headers");
  assert.ok(table.headers.includes("Allowance [ALLOWANCE_A] Amount (INR)"));
  assert.ok(table.headers.includes("Allowance [ALLOWANCE_B] Amount (INR)"));
  assert.ok(table.headers.includes("Recovery [RECOVERY_A] Deduction (INR)"));
  assert.ok(table.headers.includes("Recovery [RECOVERY_B] Deduction (INR)"));
});

test("the same head has one column block across dated rates without losing units or money", () => {
  const row = {
    ...combinedMethodRow,
    productionBreakdown: [
      { code: "DELIVERY", label: "Delivery", componentType: "production", count: 100, rate: 13, amount: 1300 },
      { code: "DELIVERY", label: "Delivery", componentType: "production", count: 50, rate: 15, amount: 750 }
    ]
  };
  const table = buildWorkforcePayoutExportTable([row], "Workforce");
  assert.equal(table.rows[0][table.headers.indexOf("Delivery Rate (INR)")], "13 / 15");
  assert.equal(table.rows[0][table.headers.indexOf("Delivery Units")], 150);
  assert.equal(table.rows[0][table.headers.indexOf("Delivery Amount (INR)")], 2050);
  assert.equal(table.headers.filter(header => header.startsWith("Delivery ")).length, 3);

});

test("Workforce exports payable units while Helper keeps its threshold audit columns", () => {
  const row = {
    ...combinedMethodRow,
    productionBreakdown: [
      { code: "DELIVERY", label: "Delivery", componentType: "production", reportedCount: 130, thresholdDeducted: 100, count: 30, rate: 13, amount: 390, thresholdPeriod: "month", thresholdMinimum: 100 },
      { code: "SELLER_PICKUP", label: "MFN", componentType: "production", count: 12, rate: 5, amount: 60 }
    ]
  };
  const table = buildWorkforcePayoutExportTable([row], "Workforce");

  assert.equal(table.rows[0][table.headers.indexOf("Delivery Units")], 30);
  assert.equal(table.rows[0][table.headers.indexOf("Delivery Amount (INR)")], 390);
  assert.ok(!table.headers.some(header => /Threshold|Reported Units|Minimum Units/.test(header)));
  assert.deepEqual(table.headers.filter(header => header.startsWith("MFN ")),
    ["MFN Units", "MFN Rate (INR)", "MFN Amount (INR)"]);
  const helper = buildWorkforcePayoutExportTable([row], "Helper");
  assert.equal(helper.rows[0][helper.headers.indexOf("Delivery Reported Units")], 130);
  assert.equal(helper.rows[0][helper.headers.indexOf("Delivery Threshold / Excluded Units")], 100);
  assert.equal(helper.rows[0][helper.headers.indexOf("Delivery Payable Units")], 30);

});

test("row-specific rates share one head block and every exported row aligns with the headers", () => {
  const second = { ...combinedMethodRow, designationCode: "MASTER_DR", designation: "Incorrect display name", productionBreakdown: [
    { code: "DELIVERY", label: "Delivery", componentType: "production", count: 10.5, rate: 15, amount: 157.5 },
  ] };
  const table = buildWorkforcePayoutExportTable([combinedMethodRow, second], "Workforce");
  assert.ok(table.rows.every(row => row.length === table.headers.length));
  assert.equal(table.headers.filter(header => header.startsWith("Delivery ")).length, 3);
  assert.equal(table.rows[0][table.headers.indexOf("Delivery Rate (INR)")], 13);
  assert.equal(table.rows[1][table.headers.indexOf("Delivery Rate (INR)")], 15);
  assert.equal(table.rows[1][table.headers.indexOf("Delivery Units")], 10.5);
  assert.equal(table.rows[1][table.headers.indexOf("Designation")], "MASTER_DR");
  assert.equal(table.rows[1][table.headers.indexOf("C-return Rate (INR)")], "");
  assert.equal(table.rows[1][table.headers.indexOf("C-return Units")], 0);
  const missingCode = buildWorkforcePayoutExportTable([{ ...second, designationCode: "" }], "Workforce");
  assert.equal(missingCode.rows[0][missingCode.headers.indexOf("Designation")], "");
});

test("Helper export retains its existing identity labels, designation, base payment and attendance source", () => {
  const table = buildWorkforcePayoutExportTable([combinedMethodRow], "Helper");
  assert.ok(table.headers.includes("Provider / Allocation"));
  assert.ok(table.headers.includes("Model / Basis"));
  assert.equal(table.rows[0][table.headers.indexOf("Base Payment (INR)")], combinedMethodRow.baseAmount);
  assert.equal(table.rows[0][table.headers.indexOf("Attendance Source")], "Biometric");
  assert.equal(table.rows[0][table.headers.indexOf("Designation")], "DR - Driver");
});
