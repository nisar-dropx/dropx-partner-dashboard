import { sendMobileLoginOtp } from "@/lib/mobile-login-otp";
import { findAuthorizedPeopleProfileByMobile } from "@/lib/people/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return sendMobileLoginOtp(request, {
    appName: "DropX People",
    findProfile: findAuthorizedPeopleProfileByMobile,
    purpose: "people_login"
  });
}
