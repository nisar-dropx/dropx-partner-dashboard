import { verifyMobileLoginOtp } from "@/lib/mobile-login-otp";
import { findAuthorizedPeopleProfileByMobile, safePeopleNextPath } from "@/lib/people/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return verifyMobileLoginOtp(request, {
    appName: "DropX People",
    findProfile: findAuthorizedPeopleProfileByMobile,
    forceOpsStorage: false,
    inactiveMessage: "Your People access is no longer active.",
    purpose: "people_login",
    redirectTo: "https://people.dropxlogistics.com/",
    safeNextPath: safePeopleNextPath
  });
}
