import "server-only";
import { callWorkforceAmazonWorker } from "@/lib/workforce-amazon-worker";

type ProfileType = "employee" | "contractor" | "workforce";

export async function enqueueActivationAutomation(input: {
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
  isDeliveryAssociate?: boolean;
  accountKey?: "edsp" | "now";
}) {
  const payload = {
    fullName: input.fullName,
    dob: input.dob,
    gender: input.gender,
    doj: input.doj,
    email: input.email,
    mobile: input.mobile,
    designation: input.designation,
    location: input.stationCode
  };
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
      }).catch((error) => console.error("[lifecycle-automation] marsh enroll", error))
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
        payload
      })
    }).catch((error) => console.error("[lifecycle-automation] idfy enroll", error))
  );
  await Promise.allSettled(tasks);
}

export async function enqueueOffboardAutomation(input: {
  profileType: ProfileType;
  profileId: string;
  pan?: string | null;
  dateOfLeaving: string;
}) {
  if (!input.pan) return;
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
