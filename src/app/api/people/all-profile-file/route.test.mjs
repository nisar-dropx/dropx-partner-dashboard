import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("All People attachment preview is allowlisted and never accepts a storage path", () => {
  for (const [key, column] of Object.entries({
    aadhaarFrontFile: "aadhaar_front_path",
    aadhaarBackFile: "aadhaar_back_path",
    panFile: "pan_upload_path",
    drivingLicenseFrontFile: "dl_front_path",
    drivingLicenseBackFile: "dl_back_path",
    profilePhotoFile: "profile_photo_path"
  })) {
    assert.match(route, new RegExp(`${key}: "${column}"`));
  }
  assert.doesNotMatch(route, /searchParams\.get\("path"\)/);
  assert.match(route, /const storagePath = String\(row\[column\]/);
});

test("attachment preview enforces session, All People permission, company, UUID, location, and designation scope", () => {
  assert.match(route, /if \(!authorization\).*status: 401/);
  assert.match(route, /hasPermission\(authorization, "people_all", "access"\)/);
  assert.match(route, /\^\[0-9a-f\]\{8\}/);
  assert.match(route, /\.eq\("company_id", companyId\)[\s\S]*?\.eq\("id", id\)/);
  assert.match(route, /from\("workforce_categories"\)[\s\S]*?\.eq\("code", category\)[\s\S]*?\.eq\("is_active", true\)/);
  assert.match(route, /authorization\.locationScopeIds\.includes\(locationId\)/);
  assert.match(route, /isCompanyOwner\(authorization\)/);
  assert.match(route, /from\("designations"\)[\s\S]*?\.select\("id, name, portal_permissions"\)[\s\S]*?\.eq\("company_id", companyId\)[\s\S]*?\.eq\("is_active", true\)/);
  assert.match(route, /canAccessDesignationPortal\(designation, "dashboard", "view", \{ isOwner: ownerAccess \}\)/);
  assert.match(route, /if \(!canAccessDesignationPortal[\s\S]*?"Attachment access denied\."[\s\S]*?status: 403/);
});

test("attachment preview supports every consolidated source without requiring hidden source-page access", () => {
  assert.match(route, /employees: \{ table: "employees", designationField: "designation_id" \}/);
  assert.match(route, /contractors: \{ table: "contractors", designationField: "designation" \}/);
  assert.match(route, /vendors: \{ table: "vendors", designationField: "designation" \}/);
  assert.match(route, /workers: \{ table: "helpers", designationField: "designation" \}/);
  assert.match(route, /workforce: \{ table: "workforce", designationField: "designation_id" \}/);
  assert.match(route, /dynamicWorkforceTable\(category\)/);
  assert.match(route, /dynamicWorkforceTable\(category\), designationField: "designation"/);
  assert.match(route, /\.select\(`location_id, \$\{column\}, \$\{source\.designationField\}`\)/);
  assert.match(route, /source\.designationField === "designation_id"[\s\S]*?String\(item\.id[\s\S]*?: String\(item\.name[\s\S]*?\.toLowerCase\(\) === designationValue\.toLowerCase\(\)/);
  assert.doesNotMatch(route, /hasPermission\(authorization, source\.pageCode/);
});

test("attachment bytes are preview-only, non-cached, sandboxed, and limited to safe image/PDF MIME types", () => {
  assert.match(route, /function previewContentType\(buffer: ArrayBuffer\)/);
  assert.match(route, /starts\(0x25, 0x50, 0x44, 0x46\).*"application\/pdf"/);
  for (const mime of ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff"]) {
    assert.ok(route.includes(`"${mime}"`));
  }
  assert.match(route, /status: 415/);
  assert.match(route, /const body = await file\.data\.arrayBuffer\(\)/);
  assert.match(route, /"Content-Disposition": `inline;/);
  assert.match(route, /"Content-Security-Policy": "sandbox;/);
  assert.match(route, /"Cache-Control": "private, max-age=0, no-store"/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.doesNotMatch(route, /attachment; filename/);
});
