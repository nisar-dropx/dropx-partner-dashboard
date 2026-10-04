import { findFleetMobileProfile } from "@/lib/fleet-mobile-login";
import { sendMobileLoginOtp } from "@/lib/mobile-login-otp";

export async function POST(request: Request) {
  return sendMobileLoginOtp(request, {
    appName: "DropX Fleet",
    findProfile: findFleetMobileProfile,
    purpose: "fleet_login"
  });
}
