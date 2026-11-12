import "server-only";

type DriveUploadResult = { id: string; webViewLink: string; mimeType: string };

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export function fleetChallanDriveConfigured() {
  return Boolean(
    clean(process.env.GOOGLE_OAUTH_CLIENT_ID) &&
      clean(process.env.GOOGLE_OAUTH_CLIENT_SECRET) &&
      clean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN) &&
      (clean(process.env.FLEET_CHALLAN_DRIVE_FOLDER_ID) || clean(process.env.MARSH_DRIVE_FOLDER_ID))
  );
}

export function fleetChallanDriveFolderId() {
  return clean(process.env.FLEET_CHALLAN_DRIVE_FOLDER_ID) || clean(process.env.MARSH_DRIVE_FOLDER_ID);
}

async function googleAccessToken() {
  const clientId = clean(process.env.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = clean(process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  const refresh = clean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);
  if (!clientId || !clientSecret || !refresh) {
    throw new Error("Google Drive OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN).");
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token"
    }),
    cache: "no-store"
  });
  const json = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !json.access_token) {
    throw new Error(`Google token refresh failed: ${json.error || response.status}`);
  }
  return json.access_token;
}

/** Stream bytes into Fleet_Challans Drive folder (same OAuth pattern as Marsh insurance cards). */
export async function uploadFleetChallanDriveFile(input: {
  name: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<DriveUploadResult> {
  const folderId = fleetChallanDriveFolderId();
  if (!folderId) throw new Error("Set FLEET_CHALLAN_DRIVE_FOLDER_ID (or MARSH_DRIVE_FOLDER_ID) for challan evidence.");
  const token = await googleAccessToken();
  const boundary = `fleet-challan-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: input.name.slice(0, 180),
    parents: [folderId]
  });
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const fileHead = `--${boundary}\r\nContent-Type: ${input.mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const enc = new TextEncoder();
  const head = enc.encode(metaPart + fileHead);
  const end = enc.encode(tail);
  const body = new Uint8Array(head.length + input.bytes.length + end.length);
  body.set(head, 0);
  body.set(input.bytes, head.length);
  body.set(end, head.length + input.bytes.length);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`
      },
      body,
      cache: "no-store"
    }
  );
  const data = (await response.json()) as { id?: string; webViewLink?: string; error?: { message?: string } };
  if (!response.ok || !data.id) throw new Error(data.error?.message || `Drive upload HTTP ${response.status}`);
  return {
    id: data.id,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    mimeType: input.mime
  };
}

/** Pull remote challan PDF/image and stream into Drive without writing local disk. */
export async function mirrorChallanEvidenceToDrive(input: {
  sourceUrl: string;
  fileName: string;
}): Promise<DriveUploadResult | null> {
  if (!fleetChallanDriveConfigured()) return null;
  const url = clean(input.sourceUrl);
  if (!/^https:\/\//i.test(url)) throw new Error("Evidence URL must be https.");
  const response = await fetch(url, { cache: "no-store", redirect: "follow" });
  if (!response.ok) throw new Error(`Evidence download failed (${response.status}).`);
  const mime = clean(response.headers.get("content-type")).split(";")[0] || "application/pdf";
  if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mime)) {
    throw new Error("Evidence must be a PDF or image.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Evidence must be between 1 byte and 20 MB.");
  return uploadFleetChallanDriveFile({ name: input.fileName, mime, bytes });
}
