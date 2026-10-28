import "server-only";

/**
 * Download a Marsh insurance PDF from Google Drive (same OAuth as the workforce worker),
 * with a worker proxy fallback when Drive OAuth is not configured on Connect.
 */

async function googleAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refresh) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000)
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(json.error || `Google token refresh failed (${res.status})`);
  return json.access_token;
}

function workerConfig() {
  const baseUrl = (process.env.WORKFORCE_AMAZON_WORKER_URL || process.env.WORKFORCE_WORKER_URL || "")
    .trim()
    .replace(/\/$/, "");
  const adminKey = (
    process.env.WORKFORCE_AMAZON_WORKER_KEY ||
    process.env.WORKFORCE_WORKER_ADMIN_KEY ||
    process.env.ADMIN_API_KEY ||
    ""
  ).trim();
  return { baseUrl, adminKey };
}

export async function downloadMarshInsuranceFile(fileId: string): Promise<{
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
}> {
  const id = fileId.trim();
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) throw new Error("Invalid Drive file id");

  const token = await googleAccessToken();
  if (token) {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType`,
      { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) }
    );
    const meta = (await metaRes.json()) as {
      id?: string;
      name?: string;
      mimeType?: string;
      error?: { message?: string };
    };
    if (!metaRes.ok || !meta.id) throw new Error(meta.error?.message || `Drive meta HTTP ${metaRes.status}`);
    const fileRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(60_000) }
    );
    if (!fileRes.ok) throw new Error(`Drive download HTTP ${fileRes.status}`);
    return {
      bytes: await fileRes.arrayBuffer(),
      mimeType: meta.mimeType || "application/pdf",
      fileName: meta.name || `${id}.pdf`
    };
  }

  const { baseUrl, adminKey } = workerConfig();
  if (!baseUrl || !adminKey) {
    throw new Error("Insurance file service is not configured.");
  }
  const drive = await fetch(`${baseUrl}/api/admin/marsh/drive/${encodeURIComponent(id)}`, {
    headers: { "x-admin-key": adminKey },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000)
  });
  if (!drive.ok) throw new Error("Unable to open the insurance card.");
  return {
    bytes: await drive.arrayBuffer(),
    mimeType: drive.headers.get("content-type") || "application/pdf",
    fileName: `${id}.pdf`
  };
}
