import "server-only";
import { enqueueActivationJobsDirect } from "@/lib/lifecycle-activation-jobs";
import { callWorkforceAmazonWorker, workforceAmazonWorkerConfig } from "@/lib/workforce-amazon-worker";

type ProfileType = "employee" | "contractor" | "workforce";

export async function enqueueActivationAutomation(input: {
  companyId: string;
  profileType: ProfileType;
  profileId: string;
  pan?: string | null;
  email?: string | null;
  fullName?: string | null;
  dob?: string | null;
  gender?: string | null;
  doj?: string | null;
  mobile?: string | null;
  designation?: string | null;
  designationCode?: string | null;
  stationCode?: string | null;
  partnerCode?: string | null;
  channel?: string | null;
  isDeliveryAssociate?: boolean;
  accountKey?: "edsp" | "now";
  fatherName?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  pincode?: string | null;
  landmark?: string | null;
  drivingLicenseNo?: string | null;
  dlFrontPath?: string | null;
  dlBackPath?: string | null;
  dropxId?: string | null;
}) {
  const hasDl = Boolean(String(input.drivingLicenseNo || "").trim());
  const payload = {
    fullName: input.fullName,
    dob: input.dob,
    gender: input.gender,
    doj: input.doj,
    email: input.email,
    mobile: input.mobile,
    designation: input.designation,
    location: input.stationCode,
    fatherName: input.fatherName,
    father_name: input.fatherName,
    address: input.address,
    street: input.address,
    city: input.city,
    state: input.state || input.stateCode,
    stateCode: input.stateCode,
    pincode: input.pincode,
    postal_pin: input.pincode,
    landmark: input.landmark,
    drivingLicenseNo: input.drivingLicenseNo,
    driving_license_no: input.drivingLicenseNo,
    dlFrontPath: input.dlFrontPath,
    dlBackPath: input.dlBackPath,
    hasDrivingLicence: hasDl,
    dropxId: input.dropxId
  };

  // Direct DB enqueue is authoritative — never depend on a missing worker admin key.
  const direct = await enqueueActivationJobsDirect({
    companyId: input.companyId,
    profileType: input.profileType,
    profileId: input.profileId,
    pan: input.pan,
    email: input.email,
    fullName: input.fullName,
    designation: input.designation,
    designationCode: input.designationCode,
    stationCode: input.stationCode,
    partnerCode: input.partnerCode,
    channel: input.channel,
    isDeliveryAssociate: input.isDeliveryAssociate,
    accountKey: input.accountKey,
    payload,
    hasDrivingLicence: hasDl,
    drivingLicenseNo: input.drivingLicenseNo,
    dlFrontPath: input.dlFrontPath,
    dlBackPath: input.dlBackPath
  });
  console.info("[lifecycle-automation] activation jobs", {
    profileId: input.profileId,
    profileType: input.profileType,
    marsh: direct.marsh,
    idfy: direct.idfy
  });

  // Best-effort worker mirror when configured (keeps older worker-side side effects warm).
  const { configured } = workforceAmazonWorkerConfig();
  if (configured) {
    const tasks: Array<Promise<unknown>> = [];
    if (input.pan) {
      tasks.push(
        callWorkforceAmazonWorker("/api/admin/marsh/enroll", {
          method: "POST",
          body: JSON.stringify({
            profileType: input.profileType,
            profileId: input.profileId,
            pan: input.pan,
            payload,
            stationCode: input.stationCode,
            partnerCode: input.partnerCode
          })
        }).catch((error) => console.error("[lifecycle-automation] marsh enroll mirror", error))
      );
    }
    tasks.push(
      callWorkforceAmazonWorker("/api/admin/idfy/enroll", {
        method: "POST",
        body: JSON.stringify({
          accountKey: input.accountKey ?? "edsp",
          profileType: input.profileType,
          profileId: input.profileId,
          pan: input.pan,
          email: input.email,
          fullName: input.fullName,
          designationCode: input.designationCode,
          designationName: input.designation,
          isDeliveryAssociate: input.isDeliveryAssociate,
          hasDrivingLicence: hasDl,
          drivingLicenseNo: input.drivingLicenseNo,
          dlFrontPath: input.dlFrontPath,
          dlBackPath: input.dlBackPath,
          payload
        })
      }).catch((error) => console.error("[lifecycle-automation] idfy enroll mirror", error))
    );
    await Promise.allSettled(tasks);
  }

  return direct;
}

export async function enqueueOffboardAutomation(input: {
  profileType: ProfileType;
  profileId: string;
  pan?: string | null;
  dateOfLeaving: string;
}) {
  if (!input.pan) return;
  const { configured } = workforceAmazonWorkerConfig();
  if (!configured) {
    console.error("[lifecycle-automation] marsh terminate skipped: worker not configured");
    return;
  }
  await callWorkforceAmazonWorker("/api/admin/marsh/terminate", {
    method: "POST",
    body: JSON.stringify({
      pan: input.pan,
      dateOfLeaving: input.dateOfLeaving,
      profileType: input.profileType,
      profileId: input.profileId
    })
  }).catch((error) => console.error("[lifecycle-automation] marsh terminate", error));
}
