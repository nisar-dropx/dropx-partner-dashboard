import "server-only";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { CloakError, cloakCookie, cloakGet, cloakPost } from "./cloak-client";
import { cloakDisputeBody } from "./nl-dispute-policy";

const COUNTRY = "IN";
const PDF = "application/pdf";

type CloakDispute = {
  tid?: string;
  revision?: string;
  dispute_selected?: string | null;
  dispute_proof?: string | null;
};
type CloakCase = {
  tid?: string;
  case_status?: string | null;
  current_sla_stage?: string | null;
  case_with?: string | null;
  value?: string | null;
  country?: string | null;
};

/**
 * Cloak keeps one proof per dispute and names it `.pdf`, so the station's files become one PDF.
 * A single PDF is sent untouched; images are placed one per page at their own size.
 */
export async function buildCloakProof(
  files: { bytes: Uint8Array; contentType: string }[],
): Promise<Uint8Array | null> {
  if (!files.length) return null;
  if (files.length === 1 && files[0]!.contentType === PDF) return files[0]!.bytes;
  const out = await PDFDocument.create();
  for (const file of files) {
    if (file.contentType === PDF) {
      const source = await PDFDocument.load(file.bytes);
      for (const page of await out.copyPages(source, source.getPageIndices()))
        out.addPage(page);
      continue;
    }
    // Normalises WebP, transparency and phone-camera rotation into something a PDF can hold.
    const jpeg = await sharp(file.bytes)
      .rotate()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
    const image = await out.embedJpg(jpeg);
    out
      .addPage([image.width, image.height])
      .drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return out.save();
}

/**
 * Files a first-round dispute in Cloak the way its own form does:
 * presigned upload of the proof, then `handleDisputeAction`.
 * Cloak is read first, so a case that is already disputed there is never written twice.
 */
export async function fileDisputeInCloak(input: {
  tid: string;
  reason: string;
  remarks: string;
  proof: Uint8Array | null;
}): Promise<{ alreadyFiled: boolean; proofKey: string }> {
  const { tid } = input;
  if (!/^[A-Za-z0-9]{6,40}$/.test(tid))
    throw new CloakError("This case has no usable tracking ID for Cloak.", "STATE");
  const cookie = await cloakCookie();
  if (!cookie) throw new CloakError("Cloak is not connected.", "NO_SESSION");
  const [me, list, disputes] = await Promise.all([
    cloakGet<{ email?: string; permissions?: string[] }>("/api/v1/auth/me", {}, cookie),
    cloakGet<{ data?: CloakCase[] }>("/api/v1/getTIDData", { tid, country: COUNTRY }, cookie),
    cloakGet<CloakDispute[]>(
      "/api/v1/getDisputeDetails",
      { tid, dataSource: "live", country: COUNTRY },
      cookie,
    ),
  ]);
  const held = Array.isArray(disputes) ? disputes.find((d) => d?.tid === tid) : undefined;
  if (held) {
    if (held.dispute_selected !== "YES")
      throw new CloakError("Cloak already holds this case as not disputed.", "STATE");
    return { alreadyFiled: true, proofKey: held.dispute_proof ?? "" };
  }
  const rows = (list.data ?? []).filter((r) => r?.tid === tid);
  const row = rows[0];
  if (rows.length !== 1 || !row)
    throw new CloakError("Cloak does not list this case in the live month.", "STATE");
  if (row.case_status !== "not_started" || row.current_sla_stage !== "eDSP1")
    throw new CloakError("Cloak is no longer waiting for a first dispute on this case.", "STATE");
  if (!me.email || !me.permissions?.includes("write:own_data") || !row.value || !row.case_with)
    throw new CloakError("The Cloak login cannot file disputes right now.", "STATE");

  let proofKey = "";
  if (input.proof) {
    const { bucket } = await cloakGet<{ bucket?: string }>(
      "/api/v1/getBucket",
      { name: "partner_proof" },
      cookie,
    );
    if (typeof bucket !== "string" || !/^[a-z0-9.-]{3,63}$/.test(bucket))
      throw new CloakError("Cloak did not name its proof bucket.", "HTTP");
    const slot = await cloakPost<{ url?: string; key?: string }>(
      "/api/v1/presignedUpload",
      { bucketName: bucket, fileName: `cloak-${tid}-1.pdf`, fileType: PDF },
      cookie,
    );
    const target = slot.url ? new URL(slot.url) : null;
    // The proof only ever goes to Cloak's own S3 bucket, under the key Cloak chose.
    if (
      !target ||
      target.protocol !== "https:" ||
      target.hostname !== `${bucket}.s3.amazonaws.com` ||
      !slot.key ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(slot.key) ||
      slot.key.includes("..")
    )
      throw new CloakError("Cloak did not return a proof upload link.", "HTTP");
    const put = await fetch(target, {
      method: "PUT",
      headers: { "content-type": PDF },
      body: input.proof as BodyInit,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!put?.ok) throw new CloakError("The proof could not be uploaded to Cloak.", "NETWORK");
    proofKey = slot.key;
  }

  const saved = await cloakPost<{ updatedItem?: CloakDispute }>(
    "/api/v1/handleDisputeAction",
    cloakDisputeBody({
      tid,
      reason: input.reason,
      remarks: input.remarks,
      proofKey,
      email: me.email,
      caseWith: row.case_with,
      value: row.value,
      country: row.country || COUNTRY,
      now: Date.now(),
    }),
    cookie,
  );
  if (saved.updatedItem?.tid !== tid || saved.updatedItem.dispute_selected !== "YES")
    throw new CloakError(
      "Cloak did not confirm the dispute. Open the case in Cloak before trying again.",
      "HTTP",
    );
  return { alreadyFiled: false, proofKey };
}
