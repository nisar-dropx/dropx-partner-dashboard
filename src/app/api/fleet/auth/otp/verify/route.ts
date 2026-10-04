import { findFleetMobileProfile, safeFleetNextPath } from "@/lib/fleet-mobile-login";
import { verifyMobileLoginOtp } from "@/lib/mobile-login-otp";

export async function POST(request: Request) {
  return verifyMobileLoginOtp(request, {
    appName: "DropX Fleet",
    findProfile: findFleetMobileProfile,
    purpose: "fleet_login",
    inactiveMessage: "This account is not enabled for Fleet.",
    redirectTo: "https://fleet.dropxlogistics.com/fleet-control",
    safeNextPath: safeFleetNextPath
  });
}
