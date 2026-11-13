// Local one-shot pull for a single vehicle, for verification without the HTTP server.
//   node scripts/pull-once.mjs KL71F6997 15/01/2019
// Requires NODE_TLS_REJECT_UNAUTHORIZED=0 only if the gov TLS chain fails locally.
import { ParivahanChallanClient, parivahanIsOutstanding } from "../parivahan.mjs";
import { solveCaptcha, closeCaptcha } from "../captcha.mjs";

const vehicleNo = process.argv[2];
const rcDate = process.argv[3];
if (!vehicleNo || !rcDate) {
  console.error("Usage: node scripts/pull-once.mjs <VEHICLE_NO> <RC_DATE dd/mm/yyyy|yyyy-mm-dd>");
  process.exit(1);
}

const client = new ParivahanChallanClient({ captchaSolver: solveCaptcha, maxCaptchaAttempts: 15 });
try {
  const result = await client.pullVehicle(vehicleNo, rcDate);
  console.log("statusCode:", result.statusCode, "| total:", result.challans.length);
  for (const c of result.challans) {
    const flag = parivahanIsOutstanding(c.paymentStatus) ? "OUTSTANDING" : c.paymentStatus;
    console.log(` ${c.challanNo} | ${c.stateCode} | Rs${c.amount} | ${flag} | ${c.offenceSummary.slice(0, 50)}`);
  }
} catch (e) {
  console.error("FAILED", e.code || "", e.message);
  process.exitCode = 1;
} finally {
  await closeCaptcha();
}
