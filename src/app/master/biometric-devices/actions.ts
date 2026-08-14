"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as XLSX from "xlsx";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  BIOMETRIC_MIDDLEWARE_HOST,
  BIOMETRIC_MIDDLEWARE_PORT,
  biometricDeviceProfile
} from "@/lib/biometric/device-profiles";

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function numberValue(value: FormDataEntryValue | null, field: string) {
  const text = required(value, field);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error("Enter a valid number.");
  if (parsed < 1 || parsed > 65535) throw new Error("Device port must be between 1 and 65535.");
  return parsed;
}

function deviceRedirect(params: { error?: string; notice?: string }) {
  cookies().set("dropx_biometric_devices_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 20,
    path: "/master/biometric-devices",
    sameSite: "lax"
  });
  redirect("/master/biometric-devices");
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function payloadFromForm(formData: FormData) {
  const deviceSerial = required(formData.get("device_serial"), "Serial number").toUpperCase();
  const terminalId = required(formData.get("terminal_id"), "Device ID");
  if (!/^\d{1,10}$/.test(terminalId)) throw new Error("Device ID must be numeric.");
  const profile = biometricDeviceProfile(required(formData.get("model"), "Device model"));
  if (!profile) throw new Error("Select a supported device model.");
  return {
    device_serial: deviceSerial,
    terminal_id: terminalId,
    device_no: terminalId,
    location_id: required(formData.get("location_id"), "Location"),
    device_name: null,
    model: profile.model,
    local_ip_address: required(formData.get("local_ip_address"), "Local IP address"),
    local_port: numberValue(formData.get("local_port"), "Local port no."),
    p2p_type: clean(formData.get("p2p_type")),
    p2p_device_id: clean(formData.get("p2p_device_id")),
    connection_mode: clean(formData.get("connection_mode")) ?? "TCP_PUSH",
    middleware_host: BIOMETRIC_MIDDLEWARE_HOST,
    middleware_port: BIOMETRIC_MIDDLEWARE_PORT,
    network_password: clean(formData.get("network_password")),
    status: "Disconnected",
    is_active: true,
    remarks: null
  };
}

function normalizedHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function workbookCell(row: Record<string, unknown>, aliases: string[]) {
  const entries = new Map(Object.entries(row).map(([key, value]) => [normalizedHeader(key), value]));
  for (const alias of aliases) {
    const value = entries.get(normalizedHeader(alias));
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

async function parseDeviceWorkbook(fileValue: FormDataEntryValue | null) {
  if (!(fileValue instanceof File) || !fileValue.size) throw new Error("Choose an Excel or CSV file to upload.");
  if (fileValue.size > 5 * 1024 * 1024) throw new Error("Bulk upload file must be 5 MB or smaller.");
  const workbook = XLSX.read(Buffer.from(await fileValue.arrayBuffer()), { type: "buffer", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The uploaded file does not contain a worksheet.");
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  if (!rawRows.length) throw new Error("The uploaded file does not contain any device rows.");
  if (rawRows.length > 500) throw new Error("Upload a maximum of 500 devices at a time.");

  return rawRows.map((row, index) => {
    const rowNumber = index + 2;
    const terminalId = workbookCell(row, ["Device ID", "Terminal ID", "Device no"]);
    const deviceSerial = workbookCell(row, ["Serial no", "Serial number", "Device serial"]).toUpperCase();
    const locationCode = workbookCell(row, ["Location", "Location code"]).toUpperCase();
    const model = workbookCell(row, ["Model no", "Model", "Model number"]);
    const profile = biometricDeviceProfile(model);
    const localIpAddress = workbookCell(row, ["Local IP address", "Local IP", "IP address"]);
    const localPortText = workbookCell(row, ["Local port no", "Local port", "Port"]);
    if (!/^\d{1,10}$/.test(terminalId)) throw new Error(`Row ${rowNumber}: Device ID must be numeric.`);
    if (!deviceSerial) throw new Error(`Row ${rowNumber}: Serial number is required.`);
    if (!locationCode) throw new Error(`Row ${rowNumber}: Location is required.`);
    if (!profile) throw new Error(`Row ${rowNumber}: Select D01, Z200BW or Z305 as the device model.`);
    if (!localIpAddress) throw new Error(`Row ${rowNumber}: Local IP address is required.`);
    const localPort = Number(localPortText);
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error(`Row ${rowNumber}: Local port must be between 1 and 65535.`);
    const connectionText = workbookCell(row, ["Connection type", "Connection mode"]).toUpperCase();
    const connectionMode = connectionText === "P2P" ? "P2P" : "TCP_PUSH";
    return {
      rowNumber,
      terminalId,
      deviceSerial,
      locationCode,
      model: profile.model,
      localIpAddress,
      localPort,
      connectionMode,
      networkPassword: workbookCell(row, ["Network password", "Password"]) || null,
      p2pType: workbookCell(row, ["P2P type"]) || null,
      p2pDeviceId: workbookCell(row, ["P2P device ID", "P2P ID"]) || null,
      remarks: workbookCell(row, ["Remarks", "Remark"]) || null
    };
  });
}

export async function bulkImportBiometricDevices(formData: FormData) {
  const authorization = await requirePagePermission("biometric_devices", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const rows = await parseDeviceWorkbook(formData.get("bulk_file"));
    const duplicateSerials = rows.filter((row, index) => rows.findIndex((candidate) => candidate.deviceSerial === row.deviceSerial) !== index);
    const duplicateTerminalIds = rows.filter((row, index) => rows.findIndex((candidate) => candidate.terminalId === row.terminalId) !== index);
    if (duplicateSerials.length) throw new Error(`Row ${duplicateSerials[0].rowNumber}: Serial number is duplicated in the file.`);
    if (duplicateTerminalIds.length) throw new Error(`Row ${duplicateTerminalIds[0].rowNumber}: Device ID is duplicated in the file.`);

    const [locationsResult, existingResult] = await Promise.all([
      supabaseAdmin.from("stations").select("id, station_code").eq("company_id", companyId).eq("is_active", true).in("station_code", Array.from(new Set(rows.map((row) => row.locationCode)))),
      supabaseAdmin.from("biometric_devices").select("device_serial, terminal_id").eq("company_id", companyId)
    ]);
    if (locationsResult.error) throw new Error(locationsResult.error.message);
    if (existingResult.error) throw new Error(existingResult.error.message);
    const locations = new Map((locationsResult.data ?? []).map((location) => [String(location.station_code).toUpperCase(), String(location.id)]));
    const existingSerials = new Set((existingResult.data ?? []).map((device) => String(device.device_serial).toUpperCase()));
    const existingTerminalIds = new Set((existingResult.data ?? []).map((device) => String(device.terminal_id ?? "")).filter(Boolean));
    const importRows = rows.filter((row) => !existingSerials.has(row.deviceSerial) && !existingTerminalIds.has(row.terminalId));
    const skipped = rows.length - importRows.length;
    const payloads = importRows.map((row) => {
      const locationId = locations.get(row.locationCode);
      if (!locationId) throw new Error(`Row ${row.rowNumber}: Active location ${row.locationCode} was not found.`);
      if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(locationId)) {
        throw new Error(`Row ${row.rowNumber}: You do not have access to location ${row.locationCode}.`);
      }
      return withCompany({
        device_serial: row.deviceSerial,
        terminal_id: row.terminalId,
        device_no: row.terminalId,
        location_id: locationId,
        device_name: null,
        model: row.model,
        local_ip_address: row.localIpAddress,
        local_port: row.localPort,
        p2p_type: row.p2pType,
        p2p_device_id: row.p2pDeviceId,
        connection_mode: row.connectionMode,
        middleware_host: BIOMETRIC_MIDDLEWARE_HOST,
        middleware_port: BIOMETRIC_MIDDLEWARE_PORT,
        network_password: row.networkPassword,
        status: "Disconnected",
        is_active: true,
        remarks: row.remarks,
        created_by: authorization.userId
      }, companyId);
    });
    if (payloads.length) {
      const { error } = await supabaseAdmin.from("biometric_devices").insert(payloads);
      if (error) throw new Error(error.message);
    }
    revalidatePath("/master/biometric-devices");
    deviceRedirect({ notice: `${payloads.length} device${payloads.length === 1 ? "" : "s"} imported${skipped ? `; ${skipped} existing duplicate${skipped === 1 ? "" : "s"} skipped` : ""}.` });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    deviceRedirect({ error: error instanceof Error ? error.message : "Unable to import devices." });
  }
}

export async function createBiometricDevice(formData: FormData) {
  const authorization = await requirePagePermission("biometric_devices", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const payload = payloadFromForm(formData);
    const { error } = await supabaseAdmin.from("biometric_devices").insert(withCompany({
      ...payload,
      created_by: authorization.userId
    }, companyId));
    if (error) throw new Error(error.message);
    revalidatePath("/master/biometric-devices");
    deviceRedirect({ notice: "Device added." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    deviceRedirect({ error: error instanceof Error ? error.message : "Unable to add device." });
  }
}

export async function updateBiometricDevice(formData: FormData) {
  const authorization = await requirePagePermission("biometric_devices", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Device");
    const payload = payloadFromForm(formData);
    const { error } = await supabaseAdmin
      .from("biometric_devices")
      .update({
        ...payload,
        updated_at: new Date().toISOString()
      })
      .eq("id", id)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
    revalidatePath("/master/biometric-devices");
    deviceRedirect({ notice: "Device updated." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    deviceRedirect({ error: error instanceof Error ? error.message : "Unable to update device." });
  }
}

export async function deleteBiometricDevice(formData: FormData) {
  const authorization = await requirePagePermission("biometric_devices", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Device");
    const { error } = await supabaseAdmin
      .from("biometric_devices")
      .delete()
      .eq("id", id)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
    revalidatePath("/master/biometric-devices");
    deviceRedirect({ notice: "Device deleted." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    deviceRedirect({ error: error instanceof Error ? error.message : "Unable to delete device." });
  }
}
