import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildConnectOtpTemplateComponents } from "./whatsapp-template.ts";

test("configured authentication template maps the OTP into body and copy-code button", () => {
  const components = buildConnectOtpTemplateComponents([
    {
      type: "BODY",
      text: "*{{1}}* is your verification code. For your security, do not share this code."
    },
    {
      type: "BUTTONS",
      buttons: [{
        type: "URL",
        text: "Copy code",
        url: "https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code_expiration_minutes=10&code=otp{{1}}"
      }]
    }
  ], {
    "body.1": "otp_code",
    "button.0.1": "otp_code",
    "__otp_expiry_minutes": "10"
  }, {
    otp_code: "123456",
    expiry_minutes: "10",
    app_name: "DropX One"
  });

  assert.deepEqual(components, [
    {
      type: "body",
      parameters: [{ type: "text", text: "123456" }]
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "123456" }]
    }
  ]);
});

test("profile-edit OTP sender is bound to the configured onboarding workflow", () => {
  const source = fs.readFileSync(new URL("./connect-whatsapp-otp.ts", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../../app/api/connect/profile-edit/route.ts", import.meta.url), "utf8");

  assert.match(source, /\.from\("whatsapp_notification_configs"\)[\s\S]*?\.eq\("event_code", "onboarding_otp_verification"\)[\s\S]*?\.eq\("is_enabled", true\)/);
  assert.match(source, /\.eq\("id", config\.whatsapp_profile_id\)/);
  assert.match(source, /\.eq\("template_id", config\.template_id\)/);
  assert.match(source, /template\.status !== "APPROVED"/);
  assert.match(source, /clampOtpExpiryMinutes\(mappings\.__otp_expiry_minutes\)/);
  assert.match(route, /sendCompanyConnectOtp\(\{[\s\S]*?companyId: row\.company_id,[\s\S]*?otp/);
});
