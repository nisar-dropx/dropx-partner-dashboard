"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { sendPaymentNotification } from "@/lib/payment-email-notifications";
import { validatePaymentFile } from "@/lib/payment-file-types";
import { loadApprovalSteps, resolveInitialApprovalTarget } from "@/lib/payment-approval-steps";
import { initialStageStatus } from "@/lib/payment-stage-policy";
import { insertPaymentApprovalLog } from "@/app/payments/approvals/actions";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { attendanceCredit, dateRange, nextVendorPeriod, vendorBillingAmounts } from "@/lib/vendor-billing";

const sections = new Set(["overview", "register", "van", "security", "housekeeping", "pest", "contracts", "master"]);

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function required(value: FormDataEntryValue | null, label: string) {
  const result = clean(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function numeric(value: FormDataEntryValue | null, label: string) {
  const result = Number(required(value, label));
  if (!Number.isFinite(result) || result < 0) throw new Error(`${label} must be zero or higher.`);
  return result;
}

function sectionOf(formData: FormData, fallback = "overview") {
  const value = clean(formData.get("return_section"));
  return sections.has(value) ? value : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The vendor update could not be completed.";
}

function flash(section: string, values: { error?: string; notice?: string }): never {
  const params = new URLSearchParams({ section, ...values });
  redirect(`/vendors?${params.toString()}`);
}

async function execute(section: string, operation: () => Promise<string>) {
  let notice: string;
  try {
    notice = await operation();
  } catch (error) {
    flash(section, { error: errorMessage(error) });
  }
  revalidatePath("/vendors");
  flash(section, { notice });
}

function categoryCode(value: FormDataEntryValue | null) {
  const code = required(value, "Category code").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (code.length < 3 || code.length > 40) throw new Error("Category code must contain 3 to 40 letters or numbers.");
  return code;
}

function allowedMonths(formData: FormData) {
  const months = [...new Set(formData.getAll("allowed_payout_months").map(Number).filter((value) => [1, 3, 6, 12].includes(value)))];
  if (!months.length) throw new Error("Select at least one payout frequency.");
  return months;
}

export async function saveVendorCategory(formData: FormData) {
  const section = sectionOf(formData, "master");
  return execute(section, async () => {
    const authorization = await requirePagePermission("vendors", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const operatingModel = required(formData.get("operating_model"), "Operating model");
    if (!["fleet_attendance", "biometric_attendance", "fixed_contract"].includes(operatingModel)) throw new Error("Operating model is invalid.");
    const code = categoryCode(formData.get("code"));
    const paymentHeadId = clean(formData.get("payment_head_id")) || null;
    if (paymentHeadId) {
      const head = await supabaseAdmin.from("payment_heads").select("id").eq("company_id", companyId).eq("id", paymentHeadId).eq("is_active", true).maybeSingle();
      if (head.error || !head.data) throw new Error("Select an active payment head from this company.");
    }
    const payload = withCompany({
      code,
      name: required(formData.get("name"), "Category name"),
      operating_model: operatingModel,
      allowed_payout_months: allowedMonths(formData),
      requires_invoice: clean(formData.get("requires_invoice")) === "on",
      requires_verified_bank: true,
      payment_head_id: paymentHeadId,
      absence_policy: operatingModel === "fixed_contract" ? "not_applicable" : "missing_mark_absent",
      is_active: clean(formData.get("is_active")) !== "false",
      sort_order: Number(clean(formData.get("sort_order")) || "100"),
      updated_by: authorization.userId
    }, companyId);
    const existingId = clean(formData.get("id"));
    const result = existingId
      ? await supabaseAdmin.from("vendor_service_categories").update(payload).eq("company_id", companyId).eq("id", existingId)
      : await supabaseAdmin.from("vendor_service_categories").insert({ ...payload, created_by: authorization.userId });
    if (result.error) throw new Error(result.error.code === "23505" ? "That category code already exists." : result.error.message);
    return `${payload.name} category saved.`;
  });
}

export async function createVendorContract(formData: FormData) {
  const section = sectionOf(formData, "contracts");
  return execute(section, async () => {
    const authorization = await requirePagePermission("vendors", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const categoryId = required(formData.get("category_id"), "Service category");
    const vendorId = required(formData.get("vendor_id"), "Vendor");
    const locationId = required(formData.get("location_id"), "Location");
    const paymentContactId = required(formData.get("payment_contact_id"), "Verified bank account");
    const frequency = Number(required(formData.get("payout_frequency_months"), "Payout frequency"));
    const category = await supabaseAdmin.from("vendor_service_categories")
      .select("id,name,operating_model,allowed_payout_months,requires_invoice,payment_head_id")
      .eq("company_id", companyId).eq("id", categoryId).eq("is_active", true).maybeSingle();
    if (category.error || !category.data) throw new Error("Service category is not active.");
    if (!(category.data.allowed_payout_months ?? []).includes(frequency)) throw new Error("This payout frequency is not enabled in the category master.");
    const paymentHeadId = clean(formData.get("payment_head_id")) || category.data.payment_head_id;
    if (!paymentHeadId) throw new Error("Configure a payment head for this service category before activating a contract.");
    const fleetVehicleId = clean(formData.get("fleet_vehicle_id")) || null;
    if (category.data.operating_model === "fleet_attendance" && !fleetVehicleId) throw new Error("Select the Fleet vehicle for a van vendor contract.");
    const [vendor, station, contact, head] = await Promise.all([
      supabaseAdmin.from("vendors").select("id,full_name,is_active").eq("company_id", companyId).eq("id", vendorId).is("deleted_at", null).maybeSingle(),
      supabaseAdmin.from("stations").select("id").eq("company_id", companyId).eq("id", locationId).maybeSingle(),
      supabaseAdmin.from("payment_contacts").select("id,verified_at,bank_account_no,ifsc").eq("company_id", companyId).eq("id", paymentContactId).maybeSingle(),
      supabaseAdmin.from("payment_heads").select("id,is_active").eq("company_id", companyId).eq("id", paymentHeadId).maybeSingle()
    ]);
    if (vendor.error || !vendor.data?.is_active) throw new Error("Select an active vendor.");
    if (station.error || !station.data) throw new Error("Select a valid location.");
    if (contact.error || !contact.data?.verified_at || !contact.data.bank_account_no || !contact.data.ifsc) throw new Error("The selected bank beneficiary must be verified first.");
    if (head.error || !head.data?.is_active) throw new Error("The selected payment head is not active.");
    if (fleetVehicleId) {
      const vehicle = await supabaseAdmin.from("fleet_vehicles").select("id").eq("company_id", companyId).eq("id", fleetVehicleId).maybeSingle();
      if (vehicle.error || !vehicle.data) throw new Error("Select a valid Fleet vehicle.");
    }
    const startDate = required(formData.get("start_date"), "Start date");
    const endDate = clean(formData.get("end_date")) || null;
    const attendanceSource = category.data.operating_model === "fleet_attendance"
      ? "fleet"
      : category.data.operating_model === "biometric_attendance" ? "biometric" : "none";
    const rateType = attendanceSource === "none" ? "fixed_cycle" : required(formData.get("rate_type"), "Rate type");
    if (!["fixed_cycle", "daily_attendance"].includes(rateType)) throw new Error("Rate type is invalid.");
    const payload = withCompany({
      vendor_id: vendorId,
      category_id: categoryId,
      location_id: locationId,
      fleet_vehicle_id: fleetVehicleId,
      contract_no: required(formData.get("contract_no"), "Contract number").toUpperCase(),
      start_date: startDate,
      end_date: endDate,
      payout_frequency_months: frequency,
      rate_type: rateType,
      rate_amount: numeric(formData.get("rate_amount"), "Contract rate"),
      attendance_source: attendanceSource,
      payment_contact_id: paymentContactId,
      payment_head_id: paymentHeadId,
      invoice_required: category.data.requires_invoice,
      status: "active",
      next_period_start: startDate,
      created_by: authorization.userId,
      updated_by: authorization.userId
    }, companyId);
    const created = await supabaseAdmin.from("vendor_service_contracts").insert(payload).select("id").single();
    if (created.error) throw new Error(created.error.code === "23505" ? "That contract number already exists." : created.error.message);
    if (fleetVehicleId) await supabaseAdmin.from("fleet_vehicles").update({ vendor_id: vendorId }).eq("company_id", companyId).eq("id", fleetVehicleId);
    await supabaseAdmin.from("vendor_lifecycle_events").insert(withCompany({
      vendor_id: vendorId,
      contract_id: created.data.id,
      event_type: "contract_activated",
      to_status: "active",
      actor_user_id: authorization.userId,
      details: { category: category.data.name, location_id: locationId }
    }, companyId));
    return `${category.data.name} contract activated for ${vendor.data.full_name}.`;
  });
}

type ContractForCycle = {
  id: string;
  vendor_id: string;
  fleet_vehicle_id: string | null;
  start_date: string;
  end_date: string | null;
  payout_frequency_months: number;
  rate_type: "fixed_cycle" | "daily_attendance";
  rate_amount: number;
  attendance_source: "none" | "biometric" | "fleet";
  next_period_start: string;
  status: string;
};

async function attendanceForContract(companyId: string, contract: ContractForCycle, periodStart: string, periodEnd: string) {
  const days = dateRange(periodStart, periodEnd);
  if (contract.attendance_source === "none") return { expected: 1, present: 1, daily: {} as Record<string, number>, source: "fixed_contract" };
  const daily: Record<string, number> = Object.fromEntries(days.map(day => [day, 0]));
  if (contract.attendance_source === "biometric") {
    const enrolments = await supabaseAdmin!.from("biometric_enrolments").select("enrolment_id")
      .eq("company_id", companyId).eq("profile_type", "vendor").eq("account_id", contract.vendor_id).eq("status", "Active");
    if (enrolments.error) throw new Error(enrolments.error.message);
    const ids = (enrolments.data ?? []).map(row => row.enrolment_id);
    if (ids.length) {
      const rows = await supabaseAdmin!.from("attendance_daily").select("punch_date,status,punch_count")
        .eq("company_id", companyId).in("enrolment_id", ids).gte("punch_date", periodStart).lte("punch_date", periodEnd);
      if (rows.error) throw new Error(rows.error.message);
      for (const row of rows.data ?? []) daily[row.punch_date] = Math.max(daily[row.punch_date] ?? 0, attendanceCredit(row.status, row.punch_count));
    }
    return { expected: days.length, present: Object.values(daily).reduce((sum, value) => sum + value, 0), daily, source: "biometric" };
  }
  const [confirmations, availability] = await Promise.all([
    supabaseAdmin!.from("fleet_vehicle_day_confirmations").select("work_date,day_status")
      .eq("company_id", companyId).eq("vehicle_id", contract.fleet_vehicle_id!).gte("work_date", periodStart).lte("work_date", periodEnd),
    supabaseAdmin!.from("fleet_vehicle_day_availability").select("work_date,status,block_rent,revoked_at")
      .eq("company_id", companyId).eq("vehicle_id", contract.fleet_vehicle_id!).gte("work_date", periodStart).lte("work_date", periodEnd)
  ]);
  if (confirmations.error) throw new Error(confirmations.error.message);
  if (availability.error) throw new Error(availability.error.message);
  for (const row of confirmations.data ?? []) daily[row.work_date] = Math.max(daily[row.work_date] ?? 0, attendanceCredit(row.day_status));
  for (const row of availability.data ?? []) {
    if (row.revoked_at) continue;
    daily[row.work_date] = row.block_rent ? 0 : Math.max(daily[row.work_date] ?? 0, attendanceCredit(row.status));
  }
  return { expected: days.length, present: Object.values(daily).reduce((sum, value) => sum + value, 0), daily, source: "fleet" };
}

export async function generateVendorBillingCycle(formData: FormData) {
  const section = sectionOf(formData, "contracts");
  return execute(section, async () => {
    const authorization = await requirePagePermission("vendors", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const contractId = required(formData.get("contract_id"), "Contract");
    const contractResult = await supabaseAdmin.from("vendor_service_contracts")
      .select("id,vendor_id,fleet_vehicle_id,start_date,end_date,payout_frequency_months,rate_type,rate_amount,attendance_source,next_period_start,status")
      .eq("company_id", companyId).eq("id", contractId).maybeSingle();
    if (contractResult.error || !contractResult.data) throw new Error("Contract was not found.");
    const contract = contractResult.data as ContractForCycle;
    if (contract.status !== "active") throw new Error("Only active contracts can create billing cycles.");
    const period = nextVendorPeriod(contract.next_period_start, contract.payout_frequency_months, contract.end_date);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    if (period.periodEnd > today) throw new Error(`This cycle closes on ${period.periodEnd}. It cannot be billed early.`);
    const attendance = await attendanceForContract(companyId, contract, period.periodStart, period.periodEnd);
    const amounts = vendorBillingAmounts({
      attendanceRequired: contract.attendance_source !== "none",
      expectedUnits: attendance.expected,
      mode: contract.rate_type,
      presentUnits: attendance.present,
      rateAmount: Number(contract.rate_amount)
    });
    const cycle = await supabaseAdmin.from("vendor_billing_cycles").insert(withCompany({
      contract_id: contract.id,
      period_start: period.periodStart,
      period_end: period.periodEnd,
      due_date: period.periodEnd,
      expected_units: amounts.expectedUnits,
      present_units: amounts.presentUnits,
      absent_units: amounts.absentUnits,
      gross_amount: amounts.grossAmount,
      deduction_amount: amounts.deductionAmount,
      payable_amount: amounts.payableAmount,
      attendance_snapshot: { source: attendance.source, daily: attendance.daily, missing_mark_policy: contract.attendance_source === "none" ? "not_applicable" : "absent" },
      status: "ready",
      created_by: authorization.userId,
      updated_by: authorization.userId
    }, companyId)).select("id").single();
    if (cycle.error) throw new Error(cycle.error.code === "23505" ? "This billing cycle already exists." : cycle.error.message);
    await supabaseAdmin.from("vendor_service_contracts").update({ next_period_start: period.nextPeriodStart, updated_by: authorization.userId })
      .eq("company_id", companyId).eq("id", contract.id);
    await supabaseAdmin.from("vendor_lifecycle_events").insert(withCompany({
      vendor_id: contract.vendor_id,
      contract_id: contract.id,
      billing_cycle_id: cycle.data.id,
      event_type: "billing_cycle_generated",
      to_status: "ready",
      actor_user_id: authorization.userId,
      details: { period_start: period.periodStart, period_end: period.periodEnd, ...amounts }
    }, companyId));
    return `Billing cycle ${period.periodStart} to ${period.periodEnd} generated.`;
  });
}

function randomPaymentRequestNo() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

async function nextPaymentRequestNo(companyId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const requestNo = randomPaymentRequestNo();
    const existing = await supabaseAdmin!.from("payment_requests").select("id").eq("company_id", companyId).eq("request_no", requestNo).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) return requestNo;
  }
  throw new Error("Could not generate a payment request ID.");
}

export async function submitVendorBillingCycle(formData: FormData) {
  const section = sectionOf(formData, "contracts");
  return execute(section, async () => {
    const authorization = await requirePagePermission("vendors", "edit");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const cycleId = required(formData.get("cycle_id"), "Billing cycle");
    const result = await supabaseAdmin.from("vendor_billing_cycles").select(`
      id,period_start,period_end,payable_amount,status,
      vendor_service_contracts!inner(
        id,vendor_id,location_id,payment_contact_id,payment_head_id,invoice_required,contract_no,
        vendors!inner(full_name,mobile,email),
        stations!inner(station_code),
        vendor_service_categories!inner(name,code)
      )
    `).eq("company_id", companyId).eq("id", cycleId).maybeSingle();
    if (result.error || !result.data) throw new Error("Billing cycle was not found.");
    if (result.data.status !== "ready") throw new Error("Only a ready billing cycle can be submitted.");
    const contract = Array.isArray(result.data.vendor_service_contracts) ? result.data.vendor_service_contracts[0] : result.data.vendor_service_contracts;
    if (!contract) throw new Error("Contract details are missing.");
    const vendor = Array.isArray(contract.vendors) ? contract.vendors[0] : contract.vendors;
    const station = Array.isArray(contract.stations) ? contract.stations[0] : contract.stations;
    const category = Array.isArray(contract.vendor_service_categories) ? contract.vendor_service_categories[0] : contract.vendor_service_categories;
    const [contact, head] = await Promise.all([
      supabaseAdmin.from("payment_contacts").select("account_holder_name,bank_account_no,ifsc,verified_at,contact_no,email")
        .eq("company_id", companyId).eq("id", contract.payment_contact_id).maybeSingle(),
      supabaseAdmin.from("payment_heads").select("id,code,payment_process_role_ids,is_active")
        .eq("company_id", companyId).eq("id", contract.payment_head_id).maybeSingle()
    ]);
    if (contact.error || !contact.data?.verified_at || !contact.data.bank_account_no || !contact.data.ifsc) throw new Error("The contract bank account is no longer verified.");
    if (head.error || !head.data?.is_active || !(head.data.payment_process_role_ids ?? []).length) throw new Error("The contract payment head or Finance processor is not configured.");
    const invoice = formData.get("invoice");
    const file = invoice instanceof File && invoice.size > 0 ? invoice : null;
    if (contract.invoice_required && !file) throw new Error("Invoice is required for this service category.");
    if (file) {
      const fileError = validatePaymentFile(file);
      if (fileError) throw new Error(fileError);
    }
    const approvalSteps = await loadApprovalSteps(companyId, head.data.id);
    if (!approvalSteps.length) throw new Error("Configure this payment head in Payment Approvals master before submitting vendor invoices.");
    const target = await resolveInitialApprovalTarget(companyId, approvalSteps, contract.location_id);
    if (!target.approver) throw new Error("No active approver is mapped for this location and payment head.");
    const requestNo = await nextPaymentRequestNo(companyId);
    let storagePath: string | null = null;
    if (file) {
      const extension = (file.name.split(".").pop() || "bin").replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
      storagePath = `${companyId}/vendor-invoices/${cycleId}/${crypto.randomUUID()}.${extension}`;
      const upload = await supabaseAdmin.storage.from("payment-request-documents").upload(storagePath, file, { upsert: false });
      if (upload.error) throw new Error(`Invoice upload failed: ${upload.error.message}`);
    }
    const lastStep = approvalSteps.at(-1);
    const finalRoleIds = lastStep?.candidates.map(candidate => candidate.role_id) ?? [];
    const remarks = clean(formData.get("remarks")) || `${category?.name ?? "Vendor"} invoice ${result.data.period_start} to ${result.data.period_end}`;
    const request = await supabaseAdmin.from("payment_requests").insert(withCompany({
      request_no: requestNo,
      location_id: contract.location_id,
      location_code: station?.station_code,
      station_code: station?.station_code,
      payment_head_id: head.data.id,
      category: "expense",
      work_date: result.data.period_end,
      requested_for_name: vendor?.full_name ?? category?.name ?? "Vendor",
      amount: result.data.payable_amount,
      amount_requested: result.data.payable_amount,
      payment_mode: "account_transfer",
      bank_account_no: contact.data.bank_account_no,
      ifsc: contact.data.ifsc,
      account_holder_name: contact.data.account_holder_name,
      beneficiary_account_no: contact.data.bank_account_no,
      beneficiary_account_number: contact.data.bank_account_no,
      beneficiary_ifsc: contact.data.ifsc,
      beneficiary_account_holder: contact.data.account_holder_name,
      beneficiary_verification_status: "verified",
      contact_no: contact.data.contact_no ?? vendor?.mobile,
      email: contact.data.email ?? vendor?.email,
      remarks,
      notes: remarks,
      supporting_document_path: storagePath,
      details: {
        vendor_cycle_id: cycleId,
        vendor_contract_id: contract.id,
        contract_no: contract.contract_no,
        service_category: category?.code,
        period_start: result.data.period_start,
        period_end: result.data.period_end,
        invoice_number: clean(formData.get("invoice_number")) || null
      },
      status: "pending",
      approval_status: initialStageStatus(target.approver),
      current_step_order: target.currentStepOrder,
      total_steps: target.totalSteps,
      current_approver_user_id: target.approver.userId,
      current_approver_role_id: target.approver.roleId,
      current_approver_role_ids: target.currentApprovalRoleIds,
      final_approval_role_id: finalRoleIds[0] ?? null,
      final_approval_role_ids: finalRoleIds,
      payment_process_role_ids: head.data.payment_process_role_ids,
      requested_by: authorization.userId,
      source_system: "vendor_lifecycle",
      source_type: "vendor_billing_cycle",
      source_id: cycleId,
      source_record_id: cycleId,
      approval_steps_snapshot: approvalSteps,
      approval_pending_since: new Date().toISOString(),
      approval_routing_reason: target.approver.routingReason ?? "Vendor service payment workflow"
    }, companyId)).select("id").single();
    if (request.error) {
      if (storagePath) await supabaseAdmin.storage.from("payment-request-documents").remove([storagePath]);
      throw new Error(request.error.message);
    }
    if (storagePath) {
      const document = await supabaseAdmin.from("payment_documents").insert({
        request_id: request.data.id,
        document_type: "vendor_invoice",
        storage_bucket: "payment-request-documents",
        storage_path: storagePath,
        uploaded_by: authorization.userId
      });
      if (document.error) throw new Error(document.error.message);
    }
    const cycleUpdate = await supabaseAdmin.from("vendor_billing_cycles").update({
      invoice_number: clean(formData.get("invoice_number")) || null,
      invoice_storage_path: storagePath,
      payment_request_id: request.data.id,
      status: "approval_pending",
      updated_by: authorization.userId
    }).eq("company_id", companyId).eq("id", cycleId).eq("status", "ready");
    if (cycleUpdate.error) throw new Error(cycleUpdate.error.message);
    await insertPaymentApprovalLog(withCompany({
      payment_request_id: request.data.id,
      request_id: request.data.id,
      approver_user_id: authorization.userId,
      approver_role_id: authorization.roleId,
      approval_cycle: 1,
      action: "created",
      comments: remarks
    }, companyId), companyId);
    await supabaseAdmin.from("vendor_lifecycle_events").insert(withCompany({
      vendor_id: contract.vendor_id,
      contract_id: contract.id,
      billing_cycle_id: cycleId,
      event_type: "submitted_for_approval",
      from_status: "ready",
      to_status: "approval_pending",
      actor_user_id: authorization.userId,
      details: { payment_request_id: request.data.id, request_no: requestNo }
    }, companyId));
    await sendPaymentNotification({
      actorUserId: authorization.userId,
      companyId,
      eventType: "payment_request",
      remarks,
      requestId: request.data.id
    });
    revalidatePath("/payments/approvals");
    revalidatePath("/payments/process");
    return `Invoice submitted as payment request ${requestNo}.`;
  });
}
