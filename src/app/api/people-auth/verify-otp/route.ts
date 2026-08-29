import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json({
    error: "Mobile OTP login is not available for DropX People. Continue with your authorised DropX Google account."
  }, { status: 403 });
}
